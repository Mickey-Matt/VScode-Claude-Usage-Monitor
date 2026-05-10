import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Types ────────────────────────────────────────────────────

interface Candidate {
    path: string;
    sessionId: string;
    mtime: number;
    birthtime: number;
}

interface UsageData {
    inputTokens: number;
    cacheRead: number;
    outputTokens: number;
    model: string;
    windowSize: number;
}

interface ActiveTimeLineResult {
    totalMs: number;
    prevTs: number | null;
    exchangeStartTs: number | null;
    inExchange: boolean;
}

interface ActiveTimeCache {
    path: string;
    totalMs: number;
    fileSize: number;
    prevTs: number | null;
    exchangeStartTs: number | null;
    inExchange: boolean;
}

interface Breakdown {
    total: number;
    system_overhead: number;
    messages: number;
    free_space: number;
}

interface ContextData {
    used_percentage: number;
    remaining_percentage: number;
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_size: number;
    model: string;
    session_id: string;
    timestamp: number;
    active_time_seconds: number;
    breakdown: Breakdown;
}

// ── State ────────────────────────────────────────────────────

let statusBarItem: vscode.StatusBarItem;
let pollTimer: NodeJS.Timeout | undefined;
let fileWatcher: fs.FSWatcher | null = null;
let pendingUpdate: NodeJS.Timeout | null = null;
let lastSessionId: string | null = null;
let fastRetryTimer: NodeJS.Timeout | null = null;

// ── JSONL reading constants ──────────────────────────────────

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const TAIL_BYTES = 512 * 1024;

// ── Model context window sizes ───────────────────────────────

const MODEL_WINDOWS: Record<string, number> = {
    'gpt-5.5': 1000000, 'gpt-5.5-pro': 1000000,
    'gpt-5.4': 1000000, 'gpt-5.4-pro': 1000000,
    'gpt-5.4-mini': 400000, 'gpt-5.4-nano': 400000,
    'gpt-4.1': 1000000,
    'o3': 200000, 'o4-mini': 200000,
    'claude-opus-4-6': 1000000, 'claude-sonnet-4-6': 1000000,
    'claude-haiku-4-5-20251001': 200000,
    'gemini-3.1-pro-preview': 1000000, 'gemini-3-flash-preview': 1000000,
    'gemini-3.1-flash-lite': 1000000,
    'gemini-2.5-pro': 1000000, 'gemini-2.5-flash': 1000000,
    'gemini-2.5-flash-lite': 1000000,
    'grok-4.3': 1000000, 'grok-4-1-fast-reasoning': 1000000,
    'grok-4-1-fast-non-reasoning': 1000000,
    'grok-4.20-multi-agent-0309': 1000000,
    'grok-4.20-0309-reasoning': 1000000,
    'grok-4.20-0309-non-reasoning': 1000000,
    'mistral-large-2512': 256000, 'mistral-medium-3-5-26-04': 256000,
    'deepseek-v4-flash': 1000000, 'deepseek-v4-pro': 1000000,
    'kimi-k2.6': 256000, 'kimi-k2.5': 256000,
    'kimi-k2-thinking': 256000, 'kimi-k2-turbo-preview': 256000,
    'moonshot-v1-128k': 128000, 'moonshot-v1-32k': 32000,
    'moonshot-v1-8k': 8000,
    'qwen3.5-plus': 1000000, 'qwen3.5-flash': 1000000,
    'qwen3.6-max-preview': 256000, 'qwen3-max': 256000,
    'qwen-flash': 1000000,
    'glm-5': 200000, 'glm-5.1': 200000,
    'glm-4.7': 200000, 'glm-4.7-flashx': 200000
};

// ── Workspace to project directory name ──────────────────────

function workspaceToProjectDir(ws: string): string {
    // Claude Code replaces : \ / _ . all with -, then strips leading -
    let name = ws.replace(/:/g, '-').replace(/[\\/]/g, '-').replace(/_/g, '-').replace(/\./g, '-');
    while (name.charAt(0) === '-') {
        name = name.substring(1);
    }
    return name;
}

// ── Find the JSONL file for the current workspace ────────────

function findJsonlForWorkspace(workspaceRoot: string): { path: string; sessionId: string } | null {
    if (!fs.existsSync(PROJECTS_DIR)) return null;

    const targetLower = (workspaceRoot || '').toLowerCase();
    const expectedDir = workspaceToProjectDir(workspaceRoot).toLowerCase();
    const candidates: Candidate[] = [];

    const projDirs = fs.readdirSync(PROJECTS_DIR);
    for (const dirName of projDirs) {
        const projDir = path.join(PROJECTS_DIR, dirName);
        let stat: fs.Stats;
        try { stat = fs.statSync(projDir); } catch (_e) { continue; }
        if (!stat.isDirectory()) continue;

        const dirLower = dirName.toLowerCase();
        const files = fs.readdirSync(projDir);
        for (const fileName of files) {
            if (!fileName.endsWith('.jsonl')) continue;
            const jsonlPath = path.join(projDir, fileName);
            let fileStat: fs.Stats;
            try { fileStat = fs.statSync(jsonlPath); } catch (_e) { continue; }

            // Read first line, check cwd matches workspace
            try {
                const fd = fs.openSync(jsonlPath, 'r');
                const buf = Buffer.alloc(4096);
                const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
                fs.closeSync(fd);
                const firstLine = buf.toString('utf8', 0, bytesRead).split('\n')[0];
                const msg = JSON.parse(firstLine);
                const cwd = (msg.cwd || '').toLowerCase();

                let matches = false;
                if (cwd && cwd === targetLower) {
                    matches = true;
                } else if (!cwd && dirLower === expectedDir) {
                    matches = true;
                } else if (cwd && cwd !== targetLower) {
                    if (dirLower === expectedDir) matches = true;
                }
                if (!matches) continue;

                const birthtime = fileStat.birthtimeMs || fileStat.ctimeMs || 0;
                candidates.push({
                    path: jsonlPath,
                    sessionId: msg.sessionId || '',
                    mtime: fileStat.mtimeMs,
                    birthtime: birthtime
                });
            } catch (_e) { continue; }
        }
    }

    if (candidates.length === 0) return null;

    // Find leaders
    let mtimeLeader = candidates[0];
    let birthLeader = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
        if (candidates[i].mtime > mtimeLeader.mtime) mtimeLeader = candidates[i];
        if (candidates[i].birthtime > birthLeader.birthtime) birthLeader = candidates[i];
    }

    const NEW_SESSION_WINDOW = 60 * 1000; // 1 minute
    const best = (birthLeader !== mtimeLeader && birthLeader.birthtime >= Date.now() - NEW_SESSION_WINDOW)
        ? birthLeader  // Recently-created session trumps old session
        : mtimeLeader;

    return { path: best.path, sessionId: best.sessionId };
}

// ── Read last usage block from JSONL tail ───────────────────

const SKIP_USAGE_RE = /"(file-history-snapshot|custom-title|last-prompt|attachment|queue-operation|system)"/;

function readLastUsage(
    jsonlPath: string,
    customWindows: Record<string, number> | undefined,
    customModel: string | undefined
): UsageData | null {
    if (!jsonlPath || !fs.existsSync(jsonlPath)) return null;
    try {
        const fileSize = fs.statSync(jsonlPath).size;
        if (fileSize === 0) return null;

        // Two-stage read:
        //   1. Try the tail (512 KB) — covers the common case.
        //   2. If the tail is filled with noise types that pushed the
        //      last assistant out of the window, fall back to a full file scan.
        const stages = fileSize <= TAIL_BYTES ? [fileSize] : [TAIL_BYTES, fileSize];

        for (const stageSize of stages) {
            const readSize = Math.min(stageSize, fileSize);
            const startPos = fileSize - readSize;
            const fd = fs.openSync(jsonlPath, 'r');
            const buf = Buffer.alloc(readSize);
            fs.readSync(fd, buf, 0, readSize, startPos);
            fs.closeSync(fd);

            const raw = buf.toString('utf8');
            const lines = raw.split('\n');
            if (startPos > 0 && lines.length > 0) lines.shift();

            let skipped = 0;

            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (!line || SKIP_USAGE_RE.test(line)) { skipped++; continue; }
                try {
                    const msg = JSON.parse(line);
                    if (msg.type === 'assistant' && msg.message && msg.message.usage) {
                        const u = msg.message.usage;
                        const inputTokens: number = u.input_tokens || 0;
                        const cacheRead: number = u.cache_read_input_tokens || 0;
                        const outputTokens: number = u.output_tokens || 0;
                        const model: string = customModel || msg.message.model || 'unknown';
                        const ml = model.toLowerCase();
                        const cw = customWindows || {};
                        let windowSize: number | undefined = cw[ml];
                        if (windowSize === undefined) windowSize = MODEL_WINDOWS[ml];
                        if (windowSize === undefined) {
                            if (ml.indexOf('1m') !== -1 || ml.indexOf('deepseek') !== -1 ||
                                ml.indexOf('gemini') !== -1 || ml.indexOf('gpt-5') !== -1 ||
                                ml.indexOf('grok') !== -1 || ml.indexOf('qwen') !== -1) {
                                windowSize = 1000000;
                            } else if (ml.indexOf('mistral') !== -1 || ml.indexOf('kimi') !== -1) {
                                windowSize = 256000;
                            } else if (ml.indexOf('moonshot') !== -1) {
                                windowSize = 128000;
                            } else {
                                windowSize = 200000;
                            }
                        }
                        return { inputTokens, cacheRead, outputTokens, model, windowSize };
                    }
                } catch (_e) { continue; }
            }

            // Stage-1 exhausted without finding assistant. Only fall back
            // to a full read if noise dominated the tail (>50% skipped) —
            // which means the assistant was likely pushed out of the window.
            const noiseRatio = lines.length > 0 ? skipped / lines.length : 0;
            if (noiseRatio < 0.5) break;
        }
        return null;
    } catch (_e) {
        return null;
    }
}

// ── Compute session active time from JSONL ───────────────────

const IDLE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
let activeTimeCache: ActiveTimeCache | null = null;

function computeActiveTime(jsonlPath: string): number {
    if (!jsonlPath || !fs.existsSync(jsonlPath)) {
        activeTimeCache = null;
        return 0;
    }
    try {
        const fileSize = fs.statSync(jsonlPath).size;
        if (fileSize === 0) {
            activeTimeCache = null;
            return 0;
        }

        // Same file, same size → cached (add live ongoing gap below)
        if (!(activeTimeCache && activeTimeCache.path === jsonlPath && activeTimeCache.fileSize === fileSize)) {

            // Same file, larger → incremental read
            if (activeTimeCache && activeTimeCache.path === jsonlPath && fileSize > activeTimeCache.fileSize) {
                const startPos = activeTimeCache.fileSize;
                const newSize = fileSize - startPos;
                const fd = fs.openSync(jsonlPath, 'r');
                const buf = Buffer.alloc(newSize);
                fs.readSync(fd, buf, 0, newSize, startPos);
                fs.closeSync(fd);
                const raw = buf.toString('utf8');
                const lines = raw.split('\n');
                if (lines.length > 0) lines.shift();

                let totalMs = activeTimeCache.totalMs;
                let prevTs = activeTimeCache.prevTs;
                let exchangeStartTs = activeTimeCache.exchangeStartTs;
                let inExchange = activeTimeCache.inExchange;

                for (const line of lines) {
                    const result = processActiveTimeLine(line, totalMs, prevTs, exchangeStartTs, inExchange);
                    totalMs = result.totalMs;
                    prevTs = result.prevTs;
                    exchangeStartTs = result.exchangeStartTs;
                    inExchange = result.inExchange;
                }

                activeTimeCache.totalMs = totalMs;
                activeTimeCache.fileSize = fileSize;
                activeTimeCache.prevTs = prevTs;
                activeTimeCache.exchangeStartTs = exchangeStartTs;
                activeTimeCache.inExchange = inExchange;

            } else {
                // Different file or smaller file → full re-read
                const content = fs.readFileSync(jsonlPath, 'utf8');
                const allLines = content.split('\n');
                let totalMs = 0;
                let prevTs: number | null = null;
                let exchangeStartTs: number | null = null;
                let inExchange = false;

                for (const line of allLines) {
                    const result = processActiveTimeLine(line, totalMs, prevTs, exchangeStartTs, inExchange);
                    totalMs = result.totalMs;
                    prevTs = result.prevTs;
                    exchangeStartTs = result.exchangeStartTs;
                    inExchange = result.inExchange;
                }

                activeTimeCache = {
                    path: jsonlPath,
                    totalMs: totalMs,
                    fileSize: fileSize,
                    prevTs: prevTs,
                    exchangeStartTs: exchangeStartTs,
                    inExchange: inExchange
                };
            }
        }

        // Add live ongoing gap (user waiting for Claude — not cached)
        let settledMs = activeTimeCache!.totalMs;
        if (activeTimeCache!.inExchange &&
            activeTimeCache!.prevTs !== null &&
            activeTimeCache!.prevTs === activeTimeCache!.exchangeStartTs) {
            const ongoing = Date.now() - activeTimeCache!.prevTs;
            if (ongoing < IDLE_THRESHOLD_MS) settledMs += ongoing;
        }
        return Math.round(settledMs / 1000);

    } catch (_e) {
        activeTimeCache = null;
        return 0;
    }
}

function processActiveTimeLine(
    line: string,
    totalMs: number,
    prevTs: number | null,
    exchangeStartTs: number | null,
    inExchange: boolean
): ActiveTimeLineResult {
    const trimmed = line.trim();
    if (!trimmed || SKIP_USAGE_RE.test(trimmed)) {
        return { totalMs, prevTs, exchangeStartTs, inExchange };
    }
    try {
        const msg = JSON.parse(trimmed);
        const ts = Date.parse(msg.timestamp);
        if (isNaN(ts)) return { totalMs, prevTs, exchangeStartTs, inExchange };

        const isUser = msg.type === 'user';
        const isRelevant = isUser || msg.type === 'assistant' ||
            msg.type === 'tool_use' || msg.type === 'tool_result' ||
            msg.type === 'thinking' || msg.type === 'text';

        if (isUser) {
            if (inExchange && prevTs !== null) {
                const gap = ts - prevTs;
                if (gap < IDLE_THRESHOLD_MS) {
                    totalMs += gap;
                }
            }
            inExchange = true;
            exchangeStartTs = ts;
            prevTs = ts;
        } else if (isRelevant && inExchange) {
            if (prevTs !== null) {
                const gap = ts - prevTs;
                if (gap < IDLE_THRESHOLD_MS) {
                    totalMs += gap;
                } else {
                    exchangeStartTs = ts;
                }
            }
            prevTs = ts;
        }
    } catch (_e) { /* skip malformed JSON */ }
    return { totalMs, prevTs, exchangeStartTs, inExchange };
}

// ── Compute breakdown from API usage data ────────────────────

function computeBreakdownFromUsage(usage: UsageData, systemOverhead: number): ContextData {
    const apiInput = usage.inputTokens + usage.cacheRead;
    const total = apiInput + usage.outputTokens;
    const windowSize = usage.windowSize;

    let usedPct: number;
    if (total > 0 && windowSize > 0) {
        usedPct = Math.min(99.9, total * 100.0 / windowSize);
    } else {
        usedPct = 0;
    }

    const messages = Math.max(0, total - systemOverhead);
    const freeSpace = Math.max(0, windowSize - total);

    return {
        used_percentage: Math.round(usedPct * 10) / 10,
        remaining_percentage: Math.max(0.1, Math.round((100 - usedPct) * 10) / 10),
        total_input_tokens: apiInput,
        total_output_tokens: usage.outputTokens,
        context_window_size: windowSize,
        model: usage.model,
        session_id: '',
        timestamp: Date.now() / 1000,
        active_time_seconds: 0,
        breakdown: {
            total: total,
            system_overhead: systemOverhead,
            messages: messages,
            free_space: freeSpace
        }
    };
}

// ── Main data source: read context from JSONL ────────────────

function readContextFromJsonl(workspaceRoot: string): ContextData | null {
    const found = findJsonlForWorkspace(workspaceRoot);
    if (!found) return null;

    const activeTime = computeActiveTime(found.path);
    const config = vscode.workspace.getConfiguration('fuel-gauge');
    const systemOverhead: number = config.get('systemOverhead', 18000);
    const customWindows: Record<string, number> = config.get('modelContextLength', {}) || {};
    const customModel: string = (config.get('model', '') as string).trim() || '';
    const usage = readLastUsage(found.path, customWindows, customModel);

    if (!usage) {
        // JSONL exists but no assistant message yet (fresh session)
        const fModel = customModel || '';
        let fWin = 1000000;
        if (fModel) {
            const fml = fModel.toLowerCase();
            const fcw = customWindows || {};
            fWin = fcw[fml] || MODEL_WINDOWS[fml] || 1000000;
        }
        return {
            used_percentage: 0,
            remaining_percentage: 100,
            total_input_tokens: 0,
            total_output_tokens: 0,
            context_window_size: fWin,
            model: fModel,
            session_id: found.sessionId,
            timestamp: Date.now() / 1000,
            active_time_seconds: activeTime,
            breakdown: {
                total: 0,
                system_overhead: systemOverhead,
                messages: 0,
                free_space: fWin - systemOverhead
            }
        };
    }

    const result = computeBreakdownFromUsage(usage, systemOverhead);
    result.active_time_seconds = activeTime;
    return result;
}

// ── File watcher & fast retry ────────────────────────────────

function triggerImmediateUpdate(): void {
    if (pendingUpdate) clearTimeout(pendingUpdate);
    pendingUpdate = setTimeout(() => {
        pendingUpdate = null;
        updateStatus();
    }, 2000);
}

function scheduleFastRetry(times: number, interval: number): void {
    if (fastRetryTimer) {
        clearTimeout(fastRetryTimer);
        fastRetryTimer = null;
    }
    if (times <= 0) return;
    fastRetryTimer = setTimeout(() => {
        fastRetryTimer = null;
        updateStatus();
        scheduleFastRetry(times - 1, interval);
    }, interval);
}

function setupFileWatcher(): void {
    if (!fs.existsSync(PROJECTS_DIR)) return;
    try {
        fileWatcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_eventType, filename) => {
            if (filename && filename.endsWith('.jsonl')) {
                triggerImmediateUpdate();
            }
        });
    } catch (_e) {
        // fs.watch may not be available on all platforms
    }
}

// ── Polling ──────────────────────────────────────────────────

function startPolling(): void {
    if (pollTimer) clearInterval(pollTimer);
    const config = vscode.workspace.getConfiguration('fuel-gauge');
    const intervalSeconds: number = config.get('pollInterval', 15);
    updateStatus();
    pollTimer = setInterval(updateStatus, intervalSeconds * 1000);
}

// ── Token formatting ─────────────────────────────────────────

function formatTokens(n: number): string {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
}

// ── Duration formatting ──────────────────────────────────────

function formatDuration(totalSeconds: number): string {
    if (totalSeconds <= 0) return '0s';
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
}

// ── Tooltip HTML ─────────────────────────────────────────────

function formatTooltip(data: ContextData): string {
    const config = vscode.workspace.getConfiguration('fuel-gauge');
    const systemOverhead: number = config.get('systemOverhead', 18000);
    const windowSize = data.context_window_size || 200000;
    const model = data.model || 'unknown';

    let totalTokens: number, messagesTokens: number, freeSpace: number;
    if (data.breakdown) {
        totalTokens = data.breakdown.total || 0;
        messagesTokens = data.breakdown.messages || 0;
        freeSpace = data.breakdown.free_space || 0;
    } else {
        totalTokens = Math.round(data.used_percentage * windowSize / 100);
        messagesTokens = Math.max(0, totalTokens - systemOverhead);
        freeSpace = Math.max(0, windowSize - totalTokens);
    }

    const sysPct = (systemOverhead / windowSize * 100).toFixed(1);
    const msgPct = (messagesTokens / windowSize * 100).toFixed(1);
    const totalPct = (totalTokens / windowSize * 100).toFixed(1);
    const freePct = (100 - parseFloat(totalPct)).toFixed(1);

    const spacer = '&nbsp;&nbsp;&nbsp;&nbsp;';
    const row = (label: string, tok: string, pct: string, bold: boolean): string => {
        const b = bold ? '<b>' : '';
        const be = bold ? '</b>' : '';
        return '<tr><td align=left>' + b + label + be + spacer +
            '</td><td align=left>' + b + tok + be + spacer +
            '</td><td align=left>' + b + pct + '%' + be + '</td></tr>';
    };

    const sep = '<tr><td colspan=3><hr></td></tr>';

    let html = '<table cellpadding=0>';
    html += '<tr><th align=left>Category' + spacer + '</th><th align=left>Tokens' + spacer + '</th><th align=left>Usage</th></tr>';
    html += sep;
    html += row('System overhead', formatTokens(systemOverhead), sysPct, false);
    html += row('Messages', formatTokens(messagesTokens), msgPct, false);
    html += row('Total', formatTokens(totalTokens), totalPct, true);
    html += row('Free space', formatTokens(freeSpace), freePct, false);
    html += sep;
    html += '<tr><td colspan=3>Active time: ' + formatDuration(data.active_time_seconds || 0) + '</td></tr>';
    html += '<tr><td colspan=3>Window: ' + formatTokens(windowSize) + '  |  Model: ' + model + '</td></tr>';
    html += '</table>';

    return html;
}

// ── Main status update ──────────────────────────────────────

function updateStatus(): void {
    try {
        let data: ContextData | null = null;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            data = readContextFromJsonl(workspaceFolders[0].uri.fsPath);
        }

        if (!data) {
            lastSessionId = null;
            statusBarItem.text = '$(claude)$(dashboard) 0%';
            statusBarItem.color = undefined;
            statusBarItem.tooltip = new vscode.MarkdownString('Fuel Gauge — No active Claude Code session');
            statusBarItem.show();
            return;
        }

        // Detected session change → fast retries to catch usage data appearance
        const currentSessionId = data.session_id || '';
        if (currentSessionId && currentSessionId !== lastSessionId) {
            lastSessionId = currentSessionId;
            scheduleFastRetry(3, 2000);
        }

        const pct = Math.round(data.used_percentage);
        const config = vscode.workspace.getConfiguration('fuel-gauge');
        const warningThreshold: number = config.get('warningThreshold', 60);
        const dangerThreshold: number = config.get('dangerThreshold', 80);

        const ageSeconds = data.timestamp ? (Date.now() / 1000) - data.timestamp : 0;
        const isStale = ageSeconds > 300;
        if (isStale) {
            statusBarItem.text = '$(claude)$(dashboard) ' + pct + '% $(circle-slash)';
            statusBarItem.color = undefined;
            const staleMsg = 'Fuel Gauge — ' + pct + '% (paused, last update ' + Math.round(ageSeconds / 60) + 'm ago)\n\n' + formatTooltip(data);
            const staleMd = new vscode.MarkdownString(staleMsg);
            staleMd.supportHtml = true;
            statusBarItem.tooltip = staleMd;
            statusBarItem.show();
            return;
        }

        statusBarItem.text = '$(claude)$(dashboard) ' + pct + '%';
        if (pct >= dangerThreshold) {
            statusBarItem.color = new vscode.ThemeColor('charts.red');
        } else if (pct >= warningThreshold) {
            statusBarItem.color = new vscode.ThemeColor('charts.yellow');
        } else {
            statusBarItem.color = new vscode.ThemeColor('charts.green');
        }

        const tooltipMd = new vscode.MarkdownString(formatTooltip(data));
        tooltipMd.supportHtml = true;
        statusBarItem.tooltip = tooltipMd;
        statusBarItem.show();
    } catch (_e) {
        statusBarItem.hide();
    }
}

// ── Extension lifecycle ──────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.tooltip = 'Claude Code Fuel Gauge';
    context.subscriptions.push(statusBarItem);

    startPolling();

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('fuel-gauge')) {
            startPolling();
        }
    }));

    // File watcher: detect JSONL writes (Claude responses)
    setupFileWatcher();

    // Window focus: update immediately when user switches back
    context.subscriptions.push(vscode.window.onDidChangeWindowState(e => {
        if (e.focused) updateStatus();
    }));
}

export function deactivate(): void {
    if (pollTimer) clearInterval(pollTimer);
    if (fileWatcher) { fileWatcher.close(); fileWatcher = null; }
    if (pendingUpdate) { clearTimeout(pendingUpdate); pendingUpdate = null; }
    if (fastRetryTimer) { clearTimeout(fastRetryTimer); fastRetryTimer = null; }
}
