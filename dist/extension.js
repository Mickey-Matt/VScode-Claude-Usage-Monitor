"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── State ────────────────────────────────────────────────
let statusBarItem;
let pollTimer;
let fileWatcher = null;
let pendingUpdate = null;
let lastSessionId = null;
let fastRetryTimer = null;

// ── JSONL reading constants ──────────────────────────────
const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const TAIL_BYTES = 512 * 1024;

// ── Model context window sizes ──────────────────────────────
// O(1) exact-match lookup from known model list.
// Unknown models fall back to keyword heuristic below.
var MODEL_WINDOWS = {
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

// ── Workspace to project directory name ──────────────────
function workspaceToProjectDir(ws) {
    // Claude Code replaces : \ / _ . all with -, then strips leading -
    var name = ws.replace(/:/g, '-').replace(/[\\/]/g, '-').replace(/_/g, '-').replace(/\./g, '-');
    while (name.charAt(0) === '-') {
        name = name.substring(1);
    }
    return name;
}

// ── Find the JSONL file for the current workspace ────────
function findJsonlForWorkspace(workspaceRoot) {
    if (!fs.existsSync(PROJECTS_DIR)) return null;
    var targetLower = (workspaceRoot || '').toLowerCase();
    var expectedDir = workspaceToProjectDir(workspaceRoot).toLowerCase();
    var candidates = [];

    var projDirs = fs.readdirSync(PROJECTS_DIR);
    for (var pi = 0; pi < projDirs.length; pi++) {
        var projDir = path.join(PROJECTS_DIR, projDirs[pi]);
        var stat;
        try { stat = fs.statSync(projDir); } catch (e) { continue; }
        if (!stat.isDirectory()) continue;

        var dirLower = projDirs[pi].toLowerCase();
        var files = fs.readdirSync(projDir);
        for (var fi = 0; fi < files.length; fi++) {
            if (!files[fi].endsWith('.jsonl')) continue;
            var jsonlPath = path.join(projDir, files[fi]);
            var fileStat;
            try { fileStat = fs.statSync(jsonlPath); } catch (e) { continue; }

            // Read first line, check cwd matches workspace
            try {
                var fd = fs.openSync(jsonlPath, 'r');
                var buf = Buffer.alloc(4096);
                var bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
                fs.closeSync(fd);
                var firstLine = buf.toString('utf8', 0, bytesRead).split('\n')[0];
                var msg = JSON.parse(firstLine);
                var cwd = (msg.cwd || '').toLowerCase();

                var matches = false;
                if (cwd && cwd === targetLower) {
                    matches = true;
                } else if (!cwd && dirLower === expectedDir) {
                    matches = true;
                } else if (cwd && cwd !== targetLower) {
                    if (dirLower === expectedDir) matches = true;
                }
                if (!matches) continue;

                var birthtime = fileStat.birthtimeMs || fileStat.ctimeMs || 0;
                candidates.push({
                    path: jsonlPath,
                    sessionId: msg.sessionId || '',
                    mtime: fileStat.mtimeMs,
                    birthtime: birthtime
                });
            } catch (e) { continue; }
        }
    }

    if (candidates.length === 0) return null;

    // Find leaders
    var mtimeLeader = candidates[0];
    var birthLeader = candidates[0];
    for (var ci = 1; ci < candidates.length; ci++) {
        if (candidates[ci].mtime > mtimeLeader.mtime) mtimeLeader = candidates[ci];
        if (candidates[ci].birthtime > birthLeader.birthtime) birthLeader = candidates[ci];
    }

    var best;
    var NEW_SESSION_WINDOW = 60 * 1000; // 1 minute
    if (birthLeader !== mtimeLeader && birthLeader.birthtime >= Date.now() - NEW_SESSION_WINDOW) {
        best = birthLeader; // Recently-created session trumps old session
    } else {
        best = mtimeLeader;
    }

    return { path: best.path, sessionId: best.sessionId };
}

// ── Read last usage block from JSONL tail ─────────────────
// Known types that never carry API usage — skip JSON.parse entirely.
var SKIP_USAGE_RE = /"(file-history-snapshot|custom-title|last-prompt|attachment|queue-operation|system)"/;

function readLastUsage(jsonlPath, customWindows, customModel) {
    if (!jsonlPath || !fs.existsSync(jsonlPath)) return null;
    try {
        var fileSize = fs.statSync(jsonlPath).size;
        if (fileSize === 0) return null;

        // Two-stage read:
        //   1. Try the tail (512 KB) — covers the common case.
        //   2. If the tail is filled with noise types that pushed the
        //      last assistant out of the window, fall back to a full
        //      file scan.
        var stages = fileSize <= TAIL_BYTES ? [fileSize] : [TAIL_BYTES, fileSize];

        for (var si = 0; si < stages.length; si++) {
            var readSize = Math.min(stages[si], fileSize);
            var startPos = fileSize - readSize;
            var fd = fs.openSync(jsonlPath, 'r');
            var buf = Buffer.alloc(readSize);
            fs.readSync(fd, buf, 0, readSize, startPos);
            fs.closeSync(fd);

            var raw = buf.toString('utf8');
            var lines = raw.split('\n');
            if (startPos > 0 && lines.length > 0) lines.shift();

            var skipped = 0;

            for (var i = lines.length - 1; i >= 0; i--) {
                var line = lines[i].trim();
                if (!line || SKIP_USAGE_RE.test(line)) { skipped++; continue; }
                try {
                    var msg = JSON.parse(line);
                    if (msg.type === 'assistant' && msg.message && msg.message.usage) {
                        var u = msg.message.usage;
                        var inputTokens = u.input_tokens || 0;
                        var cacheRead = u.cache_read_input_tokens || 0;
                        var outputTokens = u.output_tokens || 0;
                        var model = customModel || msg.message.model || 'unknown';
                        var ml = model.toLowerCase();
                        var cw = customWindows || {};
                        var windowSize = cw[ml];
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
            var noiseRatio = lines.length > 0 ? skipped / lines.length : 0;
            if (noiseRatio < 0.5) break;
        }
        return null;
    } catch (_e) {
        return null;
    }
}

// ── Compute session active time from JSONL ────────────────
// Active time = sum of gaps between consecutive messages within
// each response chain. Gaps > IDLE_THRESHOLD are skipped (user idle).
// Uses incremental cache: only parses new bytes since last read.
var IDLE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
var activeTimeCache = null; // { path, totalMs, fileSize, prevTs, exchangeStartTs, inExchange }

function computeActiveTime(jsonlPath) {
    if (!jsonlPath || !fs.existsSync(jsonlPath)) {
        activeTimeCache = null;
        return 0;
    }
    try {
        var fileSize = fs.statSync(jsonlPath).size;
        if (fileSize === 0) {
            activeTimeCache = null;
            return 0;
        }

        // Same file, same size → cached (add live ongoing gap below)
        if (!(activeTimeCache && activeTimeCache.path === jsonlPath && activeTimeCache.fileSize === fileSize)) {

            // Same file, larger → incremental read
            if (activeTimeCache && activeTimeCache.path === jsonlPath && fileSize > activeTimeCache.fileSize) {
                var startPos = activeTimeCache.fileSize;
                var newSize = fileSize - startPos;
                var fd = fs.openSync(jsonlPath, 'r');
                var buf = Buffer.alloc(newSize);
                fs.readSync(fd, buf, 0, newSize, startPos);
                fs.closeSync(fd);
                var raw = buf.toString('utf8');
                var lines = raw.split('\n');
                if (lines.length > 0) lines.shift();

                var totalMs = activeTimeCache.totalMs;
                var prevTs = activeTimeCache.prevTs;
                var exchangeStartTs = activeTimeCache.exchangeStartTs;
                var inExchange = activeTimeCache.inExchange;

                for (var i = 0; i < lines.length; i++) {
                    var incResult = processActiveTimeLine(lines[i], totalMs, prevTs, exchangeStartTs, inExchange);
                    totalMs = incResult.totalMs;
                    prevTs = incResult.prevTs;
                    exchangeStartTs = incResult.exchangeStartTs;
                    inExchange = incResult.inExchange;
                }

                activeTimeCache.totalMs = totalMs;
                activeTimeCache.fileSize = fileSize;
                activeTimeCache.prevTs = prevTs;
                activeTimeCache.exchangeStartTs = exchangeStartTs;
                activeTimeCache.inExchange = inExchange;

            } else {
                // Different file or smaller file → full re-read
                var content = fs.readFileSync(jsonlPath, 'utf8');
                var allLines = content.split('\n');
                var totalMs = 0;
                var prevTs = null;
                var exchangeStartTs = null;
                var inExchange = false;

                for (var j = 0; j < allLines.length; j++) {
                    var fullResult = processActiveTimeLine(allLines[j], totalMs, prevTs, exchangeStartTs, inExchange);
                    totalMs = fullResult.totalMs;
                    prevTs = fullResult.prevTs;
                    exchangeStartTs = fullResult.exchangeStartTs;
                    inExchange = fullResult.inExchange;
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
        var settledMs = activeTimeCache.totalMs;
        if (activeTimeCache.inExchange &&
            activeTimeCache.prevTs !== null &&
            activeTimeCache.prevTs === activeTimeCache.exchangeStartTs) {
            var ongoing = Date.now() - activeTimeCache.prevTs;
            if (ongoing < IDLE_THRESHOLD_MS) settledMs += ongoing;
        }
        return Math.round(settledMs / 1000);

    } catch (_e) {
        activeTimeCache = null;
        return 0;
    }
}

function processActiveTimeLine(line, totalMs, prevTs, exchangeStartTs, inExchange) {
    var trimmed = line.trim();
    if (!trimmed || SKIP_USAGE_RE.test(trimmed)) return { totalMs: totalMs, prevTs: prevTs, exchangeStartTs: exchangeStartTs, inExchange: inExchange };
    try {
        var msg = JSON.parse(trimmed);
        var ts = Date.parse(msg.timestamp);
        if (isNaN(ts)) return { totalMs: totalMs, prevTs: prevTs, exchangeStartTs: exchangeStartTs, inExchange: inExchange };
        var isUser = msg.type === 'user';
        var isRelevant = isUser || msg.type === 'assistant' ||
            msg.type === 'tool_use' || msg.type === 'tool_result' ||
            msg.type === 'thinking' || msg.type === 'text';

        if (isUser) {
            if (inExchange && prevTs !== null) {
                var gap = ts - prevTs;
                if (gap < IDLE_THRESHOLD_MS) {
                    totalMs += gap;
                }
            }
            inExchange = true;
            exchangeStartTs = ts;
            prevTs = ts;
        } else if (isRelevant && inExchange) {
            if (prevTs !== null) {
                var gap = ts - prevTs;
                if (gap < IDLE_THRESHOLD_MS) {
                    totalMs += gap;
                } else {
                    exchangeStartTs = ts;
                }
            }
            prevTs = ts;
        }
    } catch (_e) { /* skip malformed JSON */ }
    return { totalMs: totalMs, prevTs: prevTs, exchangeStartTs: exchangeStartTs, inExchange: inExchange };
}

// ── Compute breakdown from API usage data ─────────────────
function computeBreakdownFromUsage(usage, systemOverhead) {
    var apiInput = usage.inputTokens + usage.cacheRead;
    var total = apiInput + usage.outputTokens;
    var windowSize = usage.windowSize;

    var usedPct;
    if (total > 0 && windowSize > 0) {
        usedPct = Math.min(99.9, total * 100.0 / windowSize);
    } else {
        usedPct = 0;
    }

    var messages = Math.max(0, total - systemOverhead);
    var freeSpace = Math.max(0, windowSize - total);

    return {
        used_percentage: Math.round(usedPct * 10) / 10,
        remaining_percentage: Math.max(0.1, Math.round((100 - usedPct) * 10) / 10),
        total_input_tokens: apiInput,
        total_output_tokens: usage.outputTokens,
        context_window_size: windowSize,
        model: usage.model,
        session_id: '',
        timestamp: Date.now() / 1000,
        breakdown: {
            total: total,
            system_overhead: systemOverhead,
            messages: messages,
            free_space: freeSpace
        }
    };
}

// ── Main data source: read context from JSONL ─────────────
function readContextFromJsonl(workspaceRoot) {
    var found = findJsonlForWorkspace(workspaceRoot);
    if (!found) return null;

    var activeTime = computeActiveTime(found.path);
    var config = vscode.workspace.getConfiguration('fuel-gauge');
    var systemOverhead = config.get('systemOverhead', 18000);
    var customWindows = config.get('modelContextLength', {}) || {};
    var customModel = config.get('model', '').trim() || '';
    var usage = readLastUsage(found.path, customWindows, customModel);
    if (!usage) {
        // JSONL exists but no assistant message yet (fresh session)
        var fModel = customModel || '';
        var fWin = 1000000;
        if (fModel) {
            var fml = fModel.toLowerCase();
            var fcw = customWindows || {};
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

    var result = computeBreakdownFromUsage(usage, systemOverhead);
    result.active_time_seconds = activeTime;
    return result;
}

// ── File watcher & fast retry ─────────────────────────────
function triggerImmediateUpdate() {
    if (pendingUpdate) clearTimeout(pendingUpdate);
    pendingUpdate = setTimeout(function () {
        pendingUpdate = null;
        updateStatus();
    }, 2000);
}

function scheduleFastRetry(times, interval) {
    if (fastRetryTimer) {
        clearTimeout(fastRetryTimer);
        fastRetryTimer = null;
    }
    if (times <= 0) return;
    fastRetryTimer = setTimeout(function () {
        fastRetryTimer = null;
        updateStatus();
        scheduleFastRetry(times - 1, interval);
    }, interval);
}

function setupFileWatcher() {
    if (!fs.existsSync(PROJECTS_DIR)) return;
    try {
        fileWatcher = fs.watch(PROJECTS_DIR, { recursive: true }, function (_eventType, filename) {
            if (filename && filename.endsWith('.jsonl')) {
                triggerImmediateUpdate();
            }
        });
    } catch (_e) {
        // fs.watch may not be available on all platforms
    }
}

// ── Polling ───────────────────────────────────────────────
function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    var config = vscode.workspace.getConfiguration('fuel-gauge');
    var intervalSeconds = config.get('pollInterval', 15);
    updateStatus();
    pollTimer = setInterval(updateStatus, intervalSeconds * 1000);
}

// ── Token formatting ──────────────────────────────────────
function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
}

// ── Duration formatting ───────────────────────────────────
function formatDuration(totalSeconds) {
    if (totalSeconds <= 0) return '0s';
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
}

// ── Tooltip HTML ──────────────────────────────────────────
function formatTooltip(data) {
    var config = vscode.workspace.getConfiguration('fuel-gauge');
    var systemOverhead = config.get('systemOverhead', 18000);
    var windowSize = data.context_window_size || 200000;
    var model = data.model || 'unknown';
    var fmt = formatTokens;

    var totalTokens, messagesTokens, freeSpace;
    if (data.breakdown) {
        totalTokens = data.breakdown.total || 0;
        messagesTokens = data.breakdown.messages || 0;
        freeSpace = data.breakdown.free_space || 0;
    } else {
        totalTokens = Math.round(data.used_percentage * windowSize / 100);
        messagesTokens = Math.max(0, totalTokens - systemOverhead);
        freeSpace = Math.max(0, windowSize - totalTokens);
    }

    var sysPct = (systemOverhead / windowSize * 100).toFixed(1);
    var msgPct = (messagesTokens / windowSize * 100).toFixed(1);
    var totalPct = (totalTokens / windowSize * 100).toFixed(1);
    var freePct = (100 - parseFloat(totalPct)).toFixed(1);

    var spacer = '&nbsp;&nbsp;&nbsp;&nbsp;';
    var row = function (label, tok, p, bold) {
        var b = bold ? '<b>' : '';
        var be = bold ? '</b>' : '';
        return '<tr><td align=left>' + b + label + be + spacer + '</td><td align=left>' + b + tok + be + spacer + '</td><td align=left>' + b + p + '%' + be + '</td></tr>';
    };

    var sep = '<tr><td colspan=3><hr></td></tr>';

    var html = '<table cellpadding=0>';
    html += '<tr><th align=left>Category' + spacer + '</th><th align=left>Tokens' + spacer + '</th><th align=left>Usage</th></tr>';
    html += sep;
    html += row('System overhead', fmt(systemOverhead), sysPct, false);
    html += row('Messages', fmt(messagesTokens), msgPct, false);
    html += row('Total', fmt(totalTokens), totalPct, true);
    html += row('Free space', fmt(freeSpace), freePct, false);
    html += sep;
    html += '<tr><td colspan=3>Active time: ' + formatDuration(data.active_time_seconds || 0) + '</td></tr>';
    html += '<tr><td colspan=3>Window: ' + fmt(windowSize) + '  |  Model: ' + model + '</td></tr>';
    html += '</table>';

    return html;
}

// ── Main status update ────────────────────────────────────
function updateStatus() {
    try {
        var data = null;

        var workspaceFolders = vscode.workspace.workspaceFolders;
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
        var currentSessionId = data.session_id || '';
        if (currentSessionId && currentSessionId !== lastSessionId) {
            lastSessionId = currentSessionId;
            scheduleFastRetry(3, 2000);
        }

        var pct = Math.round(data.used_percentage);
        var config = vscode.workspace.getConfiguration('fuel-gauge');
        var warningThreshold = config.get('warningThreshold', 60);
        var dangerThreshold = config.get('dangerThreshold', 80);

        var ageSeconds = data.timestamp ? (Date.now() / 1000) - data.timestamp : 0;
        var isStale = ageSeconds > 300;
        if (isStale) {
            statusBarItem.text = '$(claude)$(dashboard) ' + pct + '% $(circle-slash)';
            statusBarItem.color = undefined;
            var staleMsg = 'Fuel Gauge — ' + pct + '% (paused, last update ' + Math.round(ageSeconds / 60) + 'm ago)\n\n' + formatTooltip(data);
            var staleMd = new vscode.MarkdownString(staleMsg);
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

        var tooltipMd = new vscode.MarkdownString(formatTooltip(data));
        tooltipMd.supportHtml = true;
        statusBarItem.tooltip = tooltipMd;
        statusBarItem.show();
    } catch (_e) {
        statusBarItem.hide();
    }
}

// ── Extension lifecycle ───────────────────────────────────
function activate(context) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.tooltip = 'Claude Code Fuel Gauge';
    context.subscriptions.push(statusBarItem);

    startPolling();

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (e) {
        if (e.affectsConfiguration('fuel-gauge')) {
            startPolling();
        }
    }));

    // File watcher: detect JSONL writes (Claude responses)
    setupFileWatcher();

    // Window focus: update immediately when user switches back
    context.subscriptions.push(vscode.window.onDidChangeWindowState(function (e) {
        if (e.focused) updateStatus();
    }));
}

function deactivate() {
    if (pollTimer) clearInterval(pollTimer);
    if (fileWatcher) { fileWatcher.close(); fileWatcher = null; }
    if (pendingUpdate) { clearTimeout(pendingUpdate); pendingUpdate = null; }
    if (fastRetryTimer) { clearTimeout(fastRetryTimer); fastRetryTimer = null; }
}
//# sourceMappingURL=extension.js.map