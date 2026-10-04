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

    // ---------- 工具 ----------
    function safeName(s) {
        var t = String(s || '')
            .replace(/[\\/:*?"<>|\r\n]/g, '-')
            .trim();
        return t || 'metro-map';
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
        box.textContent = '错误：' + msg;
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
            setDropzone($('dropLines'), name || '已粘贴 lines.yml 内容');
        } else {
            state.stopsText = text;
            state.stopsName = name;
            setDropzone($('dropStops'), name || '已粘贴 stops.yml 内容');
        }
        tryParse();
    }

    function setDropzone(el, label) {
        el.classList.add('ok');
        el.querySelector('.dz-sub').textContent = '已载入：' + label;
    }

    function resetDropzone(el, sub) {
        el.classList.remove('ok');
        el.querySelector('.dz-sub').textContent = sub;
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
                setSource(kind, text, f.name + '（' + Math.round(f.size / 1024) + ' KB）');
                if (--remaining === 0) { /* done */ }
            };
            reader.onerror = function () {
                showError('读取文件失败：' + f.name);
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
            info.textContent = '还差 ' + missing.join('、') + '，导入完整后自动生成。';
            $('warnings').appendChild(info);
            return;
        }
        try {
            state.model = MMS.metro.parse(state.linesText, state.stopsText);
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
        optAuto.textContent = '自动（停靠区最多的世界）';
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
            o.textContent = w.name + '（' + w.count + ' 站）';
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
            targetSize: 1100
        };
    }

    function regenerate() {
        if (!state.model) return;
        var opts = readOptions();
        var map;
        try {
            map = MMS.geo.build(state.model, opts);
        } catch (e) {
            showError('生成失败：' + e.message);
            return;
        }
        var ui = {
            title: $('optTitle').value || '地铁线网图',
            showLegend: $('optLegend').checked,
            showScale: $('optScale').checked,
            showNorth: $('optNorth').checked,
            showFooter: $('optFooter').checked,
            fontSize: parseFloat($('optFont').value) || 12,
            lineWidth: parseFloat($('optLineWidth').value) || 7,
            dateText: new Date().toISOString().slice(0, 10)
        };
        var out = MMS.render.build(map, ui);
        state.map = map;
        state.lastRender = out;
        $('preview').innerHTML = out.svg;
        $('stageTitle').textContent = Math.round(out.width) + ' × ' + Math.round(out.height) + ' 图纸单位';
        renderFeedback(map);
        if (map.nodes.length === 0) {
            showError('没有可绘制的车站，请检查世界选择与坐标。');
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
            var html = '提示（' + all.length + '）<ul>';
            all.forEach(function (w) {
                html += '<li>' + w.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</li>';
            });
            html += '</ul>';
            box.innerHTML = html;
            $('warnings').appendChild(box);
        }
        var s = map.stats;
        $('stats').innerHTML =
            '线路：<b>' +
            s.lineCount +
            '</b> 条 &nbsp;|&nbsp; 车站：<b>' +
            s.nodeCount +
            '</b> 座<br>换乘站：<b>' +
            s.transferCount +
            '</b> 座 &nbsp;|&nbsp; 同名合并：<b>' +
            s.mergedGroupCount +
            '</b> 组<br>世界：<b>' +
            (map.world || '-') +
            '</b> &nbsp;|&nbsp; 无停靠点估算：<b>' +
            s.cornerStops +
            '</b> 处';
        var transferNames = (map.transferStations || []).map(function (node) {
            return node.name;
        });
        var transferSummary = document.createElement('div');
        transferSummary.textContent = '换乘站名：' + (transferNames.length ? transferNames.join('、') : '无');
        $('stats').appendChild(transferSummary);
        if (s.crossingCount) {
            var crossingSummary = document.createElement('div');
            crossingSummary.textContent = '非换乘交叉：' + s.crossingCount + ' 处（已用断线跨越区分）';
            $('stats').appendChild(crossingSummary);
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
        showToast('已导出 SVG：' + baseName() + '.svg', 'success');
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
                    showToast('已导出 PNG（' + (scale > 1 ? scale + 'x' : '1x') + '）', 'success');
                } else {
                    showError('PNG 生成失败，可改用「下载 SVG」。');
                }
            }, 'image/png');
        };
        img.onerror = function () {
            URL.revokeObjectURL(url);
            showError('PNG 导出失败，可改用「下载 SVG」。');
        };
        img.src = url;
    }

    function exportRmp() {
        if (!state.map) return;
        var save = MMS.rmp.build(state.map, state.lastRender ? state.lastRender.placements : null, {
            title: $('optTitle').value || 'Minecraft Metro Map',
            pathType: $('rmpPath').value
        });
        downloadBlob(
            new Blob([JSON.stringify(save)], { type: 'application/json' }),
            baseName() + '-rmp.json'
        );
        showToast('已导出 RMP 存档，可导入 Rail Map Painter 继续编辑', 'success');
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

        $('btnSample').addEventListener('click', function () {
            state.linesName = '内置示例 lines.yml';
            state.stopsName = '内置示例 stops.yml';
            state.linesText = MMS.SAMPLE.lines;
            state.stopsText = MMS.SAMPLE.stops;
            setDropzone($('dropLines'), state.linesName);
            setDropzone($('dropStops'), state.stopsName);
            $('optTitle').value = '云屿市轨道交通线网图';
            tryParse();
            showToast('已载入内置示例数据', 'info');
        });

        $('btnClear').addEventListener('click', function () {
            state.linesText = '';
            state.stopsText = '';
            state.model = null;
            state.map = null;
            state.lastRender = null;
            resetDropzone($('dropLines'), '拖入文件 / 点击选择');
            resetDropzone($('dropStops'), '拖入文件 / 点击选择');
            $('preview').innerHTML = '<div class="placeholder">等待导入配置…<br>将服务器 <code>plugins/Metro/</code> 下的 <code>lines.yml</code> 与 <code>stops.yml</code> 拖入左侧。</div>';
            $('stageTitle').textContent = '';
            clearFeedback();
            showToast('已清空当前数据', 'info');
        });

        $('btnPaste').addEventListener('click', function () {
            var l = $('taLines').value,
                s = $('taStops').value;
            if (l.trim()) setSource('lines', l, '粘贴的 lines.yml');
            if (s.trim()) setSource('stops', s, '粘贴的 stops.yml');
            if (!l.trim() && !s.trim()) showToast('请先粘贴 lines.yml 或 stops.yml 的内容', 'warning');
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

    // ---------- 启动 ----------
    document.addEventListener('DOMContentLoaded', function () {
        bind();
        // 默认载入内置示例，立即看到效果
        state.linesText = MMS.SAMPLE.lines;
        state.stopsText = MMS.SAMPLE.stops;
        state.linesName = '内置示例 lines.yml';
        state.stopsName = '内置示例 stops.yml';
        setDropzone($('dropLines'), state.linesName);
        setDropzone($('dropStops'), state.stopsName);
        $('optTitle').value = '云屿市轨道交通线网图';
        tryParse();
        showToast('已载入内置示例，可直接体验或导入自己的配置', 'info');
    });
})();
