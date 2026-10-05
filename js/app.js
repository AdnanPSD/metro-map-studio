/*
 * app.js — 界面逻辑：导入配置 → 生成线网图 → 导出 SVG / PNG / RMP 存档。
 */
(function () {
    'use strict';

    var $ = function (id) {
        return document.getElementById(id);
    };

    var state = {
        linesText: '',
        stopsText: '',
        linesName: '',
        stopsName: '',
        model: null,
        map: null,
        lastRender: null
    };

    var regenTimer = null;
    var t = MMS.i18n.t;

    // ---------- 工具 ----------
    function safeName(s) {
        var t = String(s || '')
            .replace(/[\\/:*?"<>|\r\n]/g, '-')
            .trim();
        return t || MMS.i18n.t('titleFallback');
    }

    function downloadBlob(blob, filename) {
        var a = document.createElement('a');
        var url = URL.createObjectURL(blob);
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 5000);
    }

    function showError(msg) {
        var box = document.createElement('div');
        box.className = 'errbox';
        box.textContent = t('errorPrefix') + msg;
        $('warnings').appendChild(box);
    }

    function showToast(msg, kind) {
        var root = $('toastRoot');
        if (!root) return;
        var item = document.createElement('div');
        item.className = 'toast-item' + (kind ? ' ' + kind : '');
        item.textContent = msg;
        root.appendChild(item);
        setTimeout(function () {
            item.classList.add('out');
            setTimeout(function () {
                item.remove();
            }, 280);
        }, 2600);
    }

    function clearFeedback() {
        $('warnings').innerHTML = '';
        $('stats').innerHTML = '';
    }

    // ---------- 文件导入 ----------
    function sniffKind(name, text) {
        var n = String(name || '').toLowerCase();
        if (/stop/.test(n)) return 'stops';
        if (/line/.test(n)) return 'lines';
        if (/ordered_(stop|platform)_ids|route_points/.test(text)) return 'lines';
        if (/stoppoint_location|stoppoint|stopPoint|corner1/.test(text)) return 'stops';
        if (!state.linesText) return 'lines';
        return 'stops';
    }

    function setSource(kind, text, name) {
        if (kind === 'lines') {
            state.linesText = text;
            state.linesName = name;
            setDropzone($('dropLines'), name || t('pastedLinesName'));
        } else {
            state.stopsText = text;
            state.stopsName = name;
            setDropzone($('dropStops'), name || t('pastedStopsName'));
        }
        tryParse();
    }

    function setDropzone(el, label) {
        el.classList.add('ok');
        el.querySelector('.dz-sub').textContent = t('loadedFile', { name: label });
    }

    function resetDropzone(el, sub) {
        el.classList.remove('ok');
        el.querySelector('.dz-sub').textContent = sub || t('dropHint');
    }

    function handleFiles(fileList) {
        var files = Array.prototype.slice.call(fileList || []);
        if (!files.length) return;
        var remaining = files.length;
        files.forEach(function (f) {
            var reader = new FileReader();
            reader.onload = function () {
                var text = String(reader.result || '');
                var kind = sniffKind(f.name, text);
                setSource(kind, text, f.name + ' (' + Math.round(f.size / 1024) + ' KB)');
                if (--remaining === 0) { /* done */ }
            };
            reader.onerror = function () {
                showError(t('readFileFailed', { name: f.name }));
            };
            reader.readAsText(f, 'utf-8');
        });
    }

    function bindDropzone(el) {
        el.addEventListener('click', function (e) {
            if (e.target && e.target.tagName === 'INPUT') return; // 防止程序化 click 递归
            var input = el.querySelector('input[type=file]');
            if (input) input.click();
        });
        el.addEventListener('dragover', function (e) {
            e.preventDefault();
            el.classList.add('dragover');
        });
        el.addEventListener('dragleave', function () {
            el.classList.remove('dragover');
        });
        el.addEventListener('drop', function (e) {
            e.preventDefault();
            e.stopPropagation();
            el.classList.remove('dragover');
            handleFiles(e.dataTransfer.files);
        });
        var input = el.querySelector('input[type=file]');
        if (input) {
            input.addEventListener('change', function () {
                handleFiles(input.files);
                input.value = '';
            });
        }
    }

    // ---------- 解析与生成 ----------
    function tryParse() {
        clearFeedback();
        if (!state.linesText || !state.stopsText) {
            var missing = [];
            if (!state.linesText) missing.push('lines.yml');
            if (!state.stopsText) missing.push('stops.yml');
            var info = document.createElement('div');
            info.className = 'warnbox';
            info.textContent = t('parseMissing', { files: missing.join(', ') });
            $('warnings').appendChild(info);
            return;
        }
        try {
            state.model = MMS.metro.parse(state.linesText, state.stopsText, t);
        } catch (e) {
            state.model = null;
            showError(e.message);
            return;
        }
        populateWorlds();
        regenerate();
    }

    function populateWorlds() {
        var sel = $('optWorld');
        var prev = sel.value;
        sel.innerHTML = '';
        var optAuto = document.createElement('option');
        optAuto.value = '';
        optAuto.textContent = t('autoWorld');
        sel.appendChild(optAuto);

        var count = new Map();
        state.model.stops.forEach(function (s) {
            count.set(s.world, (count.get(s.world) || 0) + 1);
        });
        var worlds = [];
        count.forEach(function (c, name) {
            worlds.push({ name: name, count: c });
        });
        worlds.sort(function (a, b) {
            return b.count - a.count;
        });
        worlds.forEach(function (w) {
            var o = document.createElement('option');
            o.value = w.name;
            o.textContent = w.name + ' (' + t(w.count === 1 ? 'stationCountOne' : 'stationCount', { count: w.count }) + ')';
            sel.appendChild(o);
        });
        if (prev) {
            var found = worlds.some(function (w) {
                return w.name === prev;
            });
            sel.value = found ? prev : '';
        }
    }

    function readOptions() {
        var modeEl = document.querySelector('input[name="mode"]:checked');
        var lineWidth = parseFloat($('optLineWidth').value) || 7;
        return {
            world: $('optWorld').value || null,
            mergeByName: $('optMerge').checked,
            autoColor: $('optAutoColor').checked,
            mode: modeEl ? modeEl.value : 'real',
            parallelSpacing: lineWidth + 3,
            targetSize: 1100,
            translate: t
        };
    }

    function regenerate() {
        if (!state.model) return;
        var opts = readOptions();
        var map;
        try {
            map = MMS.geo.build(state.model, opts);
        } catch (e) {
            showError(t('generationFailed') + e.message);
            return;
        }
        var ui = {
            title: $('optTitle').value || t('defaultMapTitle'),
            showLegend: $('optLegend').checked,
            showScale: $('optScale').checked,
            showNorth: $('optNorth').checked,
            showFooter: $('optFooter').checked,
            fontSize: parseFloat($('optFont').value) || 12,
            lineWidth: parseFloat($('optLineWidth').value) || 7,
            dateText: new Date().toISOString().slice(0, 10),
            labels: {
                legend: t('svgLegend'),
                line: map.stats.lineCount === 1 ? t('svgLine') : t('svgLines'),
                station: map.stats.nodeCount === 1 ? t('svgStation') : t('svgStations'),
                transfer: map.stats.transferCount === 1 ? t('svgTransfer') : t('svgTransfers'),
                world: t('svgWorld'),
                scaleUnit: t('svgScaleUnit'),
                footer: t('svgFooter'),
                modeReal: t('svgModeReal'),
                modeSchematic: t('svgModeSchematic'),
                modePerpendicular: t('svgModePerpendicular')
            }
        };
        var out = MMS.render.build(map, ui);
        state.map = map;
        state.lastRender = out;
        $('preview').innerHTML = out.svg;
        $('stageTitle').textContent = Math.round(out.width) + ' × ' + Math.round(out.height) + ' ' + t('drawingUnits');
        renderFeedback(map);
        if (map.nodes.length === 0) {
            showError(t('noStations'));
        }
    }

    function renderFeedback(map) {
        $('warnings').innerHTML = '';
        var all = (state.model.warnings || []).concat(map.warnings || []);
        var seen = {};
        all = all.filter(function (w) {
            if (seen[w]) return false;
            seen[w] = 1;
            return true;
        });
        if (all.length) {
            var box = document.createElement('div');
            box.className = 'warnbox';
            var boxTitle = document.createElement('strong');
            boxTitle.textContent = t('warningCount', { count: all.length });
            box.appendChild(boxTitle);
            var list = document.createElement('ul');
            all.forEach(function (w) {
                var item = document.createElement('li');
                item.textContent = w;
                list.appendChild(item);
            });
            box.appendChild(list);
            $('warnings').appendChild(box);
        }
        var s = map.stats;
        var stats = $('stats');
        stats.innerHTML = '';
        function addStat(label, value) {
            var row = document.createElement('div');
            var name = document.createElement('span');
            var number = document.createElement('b');
            name.textContent = label + ' ';
            number.textContent = value;
            row.appendChild(name);
            row.appendChild(number);
            stats.appendChild(row);
        }
        addStat(t('statLines'), s.lineCount);
        addStat(t('statStations'), s.nodeCount);
        addStat(t('statTransfers'), s.transferCount);
        addStat(t('statMerged'), s.mergedGroupCount);
        addStat(t('statWorld'), map.world || '-');
        addStat(t('statEstimatedStops'), s.cornerStops);
        var transferNames = (map.transferStations || []).map(function (node) {
            return node.name;
        });
        var transferSummary = document.createElement('div');
        transferSummary.textContent = t('transferNames') + ' ' + (transferNames.length ? transferNames.join(', ') : t('none'));
        stats.appendChild(transferSummary);
        if (s.crossingCount) {
            var crossingSummary = document.createElement('div');
            crossingSummary.textContent = t('nonTransferCrossings', { count: s.crossingCount });
            stats.appendChild(crossingSummary);
        }
    }

    function scheduleRegenerate() {
        if (regenTimer) clearTimeout(regenTimer);
        regenTimer = setTimeout(function () {
            regenTimer = null;
            regenerate();
        }, 120);
    }

    // ---------- 导出 ----------
    function baseName() {
        return safeName($('optTitle').value || 'metro-map');
    }

    function exportSvg() {
        if (!state.lastRender) return;
        downloadBlob(
            new Blob([state.lastRender.svg], { type: 'image/svg+xml;charset=utf-8' }),
            baseName() + '.svg'
        );
        showToast(t('svgExported', { name: baseName() + '.svg' }), 'success');
    }

    function exportPng() {
        if (!state.lastRender) return;
        var scale = parseFloat($('pngScale').value) || 2;
        var transparent = $('optTransparent').checked;
        var svg = state.lastRender.svg;
        var w = state.lastRender.width,
            h = state.lastRender.height;
        var img = new Image();
        var blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        img.onload = function () {
            var maxDim = 16000;
            var s = Math.min(scale, maxDim / Math.max(w, h));
            var cw = Math.max(1, Math.round(w * s));
            var ch = Math.max(1, Math.round(h * s));
            var canvas = document.createElement('canvas');
            canvas.width = cw;
            canvas.height = ch;
            var ctx = canvas.getContext('2d');
            if (!transparent) {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, cw, ch);
            }
            ctx.drawImage(img, 0, 0, cw, ch);
            URL.revokeObjectURL(url);
            canvas.toBlob(function (b) {
                if (b) {
                    downloadBlob(b, baseName() + '@' + (scale > 1 ? scale + 'x' : '1x') + '.png');
                    showToast(t('pngExported', { scale: scale > 1 ? scale + 'x' : '1x' }), 'success');
                } else {
                    showError(t('pngFailed'));
                }
            }, 'image/png');
        };
        img.onerror = function () {
            URL.revokeObjectURL(url);
            showError(t('pngExportFailed'));
        };
        img.src = url;
    }

    function exportRmp() {
        if (!state.map) return;
        var save = MMS.rmp.build(state.map, state.lastRender ? state.lastRender.placements : null, {
            title: $('optTitle').value || t('defaultMapTitle'),
            pathType: $('rmpPath').value
        });
        downloadBlob(
            new Blob([JSON.stringify(save)], { type: 'application/json' }),
            baseName() + '-rmp.json'
        );
        showToast(t('rmpExported'), 'success');
    }

    // ---------- 事件绑定 ----------
    function bindThanks() {
        var overlay = $('thanksOverlay');
        var openBtn = $('btnThanks');
        var closeBtn = $('btnThanksClose');
        if (!overlay || !openBtn) return;

        function onKey(e) {
            if (e.key === 'Escape') closeModal();
        }
        function openModal() {
            overlay.hidden = false;
            document.addEventListener('keydown', onKey);
        }
        function closeModal() {
            overlay.hidden = true;
            document.removeEventListener('keydown', onKey);
        }

        openBtn.addEventListener('click', openModal);
        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeModal();
        });
    }

    function bind() {
        bindDropzone($('dropLines'));
        bindDropzone($('dropStops'));

        $('languageSelect').value = MMS.i18n.getLanguage();
        $('languageSelect').addEventListener('change', function () {
            var previousSampleTitle = t('sampleMapTitle');
            var previousDefaultTitle = t('defaultMapTitle');
            MMS.i18n.setLanguage($('languageSelect').value);
            t = MMS.i18n.t;
            if ($('optTitle').value === previousSampleTitle || $('optTitle').value === previousDefaultTitle) {
                $('optTitle').value = t('sampleMapTitle');
            }
            if (state.linesName) setDropzone($('dropLines'), state.linesName);
            else resetDropzone($('dropLines'));
            if (state.stopsName) setDropzone($('dropStops'), state.stopsName);
            else resetDropzone($('dropStops'));
            if (!state.linesText || !state.stopsText) showWaitingPlaceholder();
            tryParse();
        });

        $('btnSample').addEventListener('click', function () {
            state.linesName = t('sampleLinesName');
            state.stopsName = t('sampleStopsName');
            state.linesText = MMS.SAMPLE.lines;
            state.stopsText = MMS.SAMPLE.stops;
            setDropzone($('dropLines'), state.linesName);
            setDropzone($('dropStops'), state.stopsName);
            $('optTitle').value = t('sampleMapTitle');
            tryParse();
            showToast(t('sampleLoaded'), 'info');
        });

        $('btnClear').addEventListener('click', function () {
            state.linesText = '';
            state.stopsText = '';
            state.linesName = '';
            state.stopsName = '';
            state.model = null;
            state.map = null;
            state.lastRender = null;
            resetDropzone($('dropLines'));
            resetDropzone($('dropStops'));
            showWaitingPlaceholder();
            $('stageTitle').textContent = '';
            clearFeedback();
            showToast(t('dataCleared'), 'info');
        });

        $('btnPaste').addEventListener('click', function () {
            var l = $('taLines').value,
                s = $('taStops').value;
            if (l.trim()) setSource('lines', l, t('pastedLinesName'));
            if (s.trim()) setSource('stops', s, t('pastedStopsName'));
            if (!l.trim() && !s.trim()) showToast(t('pasteFirst'), 'warning');
        });
        $('btnSvg').addEventListener('click', exportSvg);
        $('btnPng').addEventListener('click', exportPng);
        $('btnRmp').addEventListener('click', exportRmp);

        $('btnFit').addEventListener('click', function () {
            $('preview').classList.remove('actual');
        });
        $('btnActual').addEventListener('click', function () {
            $('preview').classList.add('actual');
        });

        // 所有选项变化后自动重绘
        [
            'optTitle',
            'optWorld',
            'optMerge',
            'optAutoColor',
            'optLineWidth',
            'optFont',
            'optLegend',
            'optScale',
            'optNorth',
            'optFooter'
        ].forEach(function (id) {
            var el = $(id);
            el.addEventListener('input', scheduleRegenerate);
            el.addEventListener('change', scheduleRegenerate);
        });
        Array.prototype.forEach.call(document.querySelectorAll('input[name="mode"]'), function (el) {
            el.addEventListener('change', scheduleRegenerate);
        });

        bindThanks();

        // 防止浏览器直接打开被拖入的文件
        document.addEventListener('dragover', function (e) {
            e.preventDefault();
        });
        document.addEventListener('drop', function (e) {
            e.preventDefault();
        });
    }

    function showWaitingPlaceholder() {
        $('preview').innerHTML = '<div class="placeholder">' + t('waiting') + '<br>' + t('emptyInstructions') + '</div>';
    }

    // ---------- 启动 ----------
    document.addEventListener('DOMContentLoaded', function () {
        bind();
        // 默认载入内置示例，立即看到效果
        state.linesText = MMS.SAMPLE.lines;
        state.stopsText = MMS.SAMPLE.stops;
        state.linesName = t('sampleLinesName');
        state.stopsName = t('sampleStopsName');
        setDropzone($('dropLines'), state.linesName);
        setDropzone($('dropStops'), state.stopsName);
        $('optTitle').value = t('sampleMapTitle');
        tryParse();
        showToast(t('sampleToast'), 'info');
    });
})();
