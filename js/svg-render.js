/*
 * svg-render.js — 把几何模型渲染成地铁线网图（SVG）。
 *
 * 绘制顺序：白色底衬（全部线路）→ 彩色线（全部线路）→ 车站 → 站名 → 图例/比例尺/指北针。
 * 站点样式：普通站白圆黑边小圈，换乘站白圆黑边大圈（经典风格）。
 */
(function (root) {
    'use strict';
    var MMS = (root.MMS = root.MMS || {});

    var FONT_STACK = "'Segoe UI','Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif";

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function fmt(n) {
        n = Math.round(n * 10) / 10;
        return String(n);
    }

    function clampText(t, maxW, fs) {
        if (MMS.geo.textWidth(t, fs) <= maxW) return t;
        var out = '';
        for (var i = 0; i < t.length; i++) {
            if (MMS.geo.textWidth(out + t[i] + '…', fs) > maxW) break;
            out += t[i];
        }
        return out + '…';
    }

    function pathD(parts) {
        var d = '';
        parts.forEach(function (part) {
            if (part.length < 2) return;
            d += 'M' + fmt(part[0].x) + ' ' + fmt(part[0].y);
            for (var i = 1; i < part.length; i++) {
                d += 'L' + fmt(part[i].x) + ' ' + fmt(part[i].y);
            }
        });
        return d;
    }

    function crossingWindow(crossing, side, halfLength) {
        var edge = crossing[side];
        var dx = edge.b.x - edge.a.x,
            dy = edge.b.y - edge.a.y;
        var length = Math.sqrt(dx * dx + dy * dy) || 1;
        var ux = dx / length,
            uy = dy / length;
        var t = ((crossing.x - edge.a.x) * ux + (crossing.y - edge.a.y) * uy) / length;
        var start = Math.max(0, t * length - halfLength);
        var end = Math.min(length, t * length + halfLength);
        return {
            x1: edge.a.x + ux * start,
            y1: edge.a.y + uy * start,
            x2: edge.a.x + ux * end,
            y2: edge.a.y + uy * end
        };
    }

    /**
     * @param {Object} map  geo.build() 的结果
     * @param {Object} opts { title, showLegend, showScale, showNorth, showFooter, fontSize, lineWidth, transparent, dateText }
     * @returns {Object} { svg, width, height, placements }
     */
    function build(map, opts) {
        opts = opts || {};
        var fs = opts.fontSize || 12;
        var lw = opts.lineWidth || 7;
        var dotR = 4.6,
            dotrInt = 6.6;

        var b = map.bounds;
        var pad = 30,
            padTop = 60,
            legendW = opts.showLegend !== false ? 208 : 0,
            legendGap = 28;

        var bottomBar = 0;
        if (opts.showScale !== false) bottomBar = 30;
        if (opts.showFooter !== false) bottomBar = Math.max(bottomBar, 34);

        var vbMinX = b.minX - pad;
        var vbMinY = b.minY - padTop;
        var vbMaxX = b.maxX + pad + (legendW ? legendW + legendGap : 0);
        var vbMaxY = b.maxY + pad + bottomBar;
        var vw = Math.max(vbMaxX - vbMinX, 200);
        var vh = Math.max(vbMaxY - vbMinY, 140);

        // 站名摆放（排除图例区域，避免文字压到图例）
        var excluded = [];
        if (legendW) {
            excluded.push({ x: b.maxX + legendGap - 16, y: b.minY - padTop, w: legendW + 20, h: vh + 40 });
        }
        var placements = MMS.geo.placeLabels(map, {
            fontSize: fs,
            dotRadius: dotrInt,
            lineWidth: lw,
            excludedRects: excluded
        });

        var out = [];
        out.push(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
                fmt(vbMinX) +
                ' ' +
                fmt(vbMinY) +
                ' ' +
                fmt(vw) +
                ' ' +
                fmt(vh) +
                '" width="' +
                fmt(vw) +
                '" height="' +
                fmt(vh) +
                '" font-family="' +
                FONT_STACK +
                '">'
        );

        if (!opts.transparent) {
            out.push(
                '<rect x="' +
                    fmt(vbMinX) +
                    '" y="' +
                    fmt(vbMinY) +
                    '" width="' +
                    fmt(vw) +
                    '" height="' +
                    fmt(vh) +
                    '" fill="#ffffff"/>'
            );
        }

        // ---------- 标题 ----------
        var title = opts.title || '地铁线网图';
        out.push(
            '<text x="' +
                fmt(b.minX) +
                '" y="' +
                fmt(b.minY - 32) +
                '" font-size="21" font-weight="700" fill="#1f2430">' +
                esc(title) +
                '</text>'
        );
        var modeLabel =
            map.mode === 'schematic' ? '45° 示意图' : map.mode === 'perpendicular' ? '直角折线' : '实际走向';
        var sub =
            map.stats.lineCount +
            ' 条线路 · ' +
            map.stats.nodeCount +
            ' 座车站 · ' +
            map.stats.transferCount +
            ' 座换乘站 · 世界 “' +
            (map.world || '-') +
            '” · ' +
            modeLabel;
        out.push(
            '<text x="' +
                fmt(b.minX) +
                '" y="' +
                fmt(b.minY - 12) +
                '" font-size="12" fill="#6b7280">' +
                esc(sub) +
                '</text>'
        );

        // ---------- 线路底衬（全部白色，保证并行线之间留白） ----------
        map.lines.forEach(function (line) {
            var d = pathD(line.segments.flatMap(function (s) {
                return s.parts;
            }));
            if (!d) return;
            out.push(
                '<path d="' +
                    d +
                    '" fill="none" stroke="#ffffff" stroke-width="' +
                    fmt(lw + 4) +
                    '" stroke-linecap="round" stroke-linejoin="round"/>'
            );
        });

        // ---------- 线路本体 ----------
        map.lines.forEach(function (line) {
            var d = pathD(line.segments.flatMap(function (s) {
                return s.parts;
            }));
            if (!d) return;
            out.push(
                '<path d="' +
                    d +
                    '" fill="none" stroke="' +
                    line.colorHex +
                    '" stroke-width="' +
                    fmt(lw) +
                    '" stroke-linecap="round" stroke-linejoin="round"/>'
            );
        });

        // ---------- 非换乘交叉：底层线路留出间隙，上层线路保持连续 ----------
        var crossingHalf = Math.max(lw * 0.65, 5);
        (map.crossings || []).forEach(function (crossing) {
            var gap = crossingWindow(crossing, 'under', crossingHalf);
            out.push(
                '<line x1="' + fmt(gap.x1) + '" y1="' + fmt(gap.y1) + '" x2="' + fmt(gap.x2) +
                    '" y2="' + fmt(gap.y2) + '" stroke="#ffffff" stroke-width="' + fmt(lw + 2) +
                    '" stroke-linecap="butt"/>'
            );
        });
        (map.crossings || []).forEach(function (crossing) {
            var over = crossingWindow(crossing, 'over', crossingHalf + 1);
            out.push(
                '<line x1="' + fmt(over.x1) + '" y1="' + fmt(over.y1) + '" x2="' + fmt(over.x2) +
                    '" y2="' + fmt(over.y2) + '" stroke="#ffffff" stroke-width="' + fmt(lw + 4) +
                    '" stroke-linecap="round"/>'
            );
            out.push(
                '<line x1="' + fmt(over.x1) + '" y1="' + fmt(over.y1) + '" x2="' + fmt(over.x2) +
                    '" y2="' + fmt(over.y2) + '" stroke="' + crossing.over.colorHex + '" stroke-width="' +
                    fmt(lw) + '" stroke-linecap="round"/>'
            );
        });

        // ---------- 车站 ----------
        map.nodes.forEach(function (n) {
            var isInt = n.isTransfer || n.lines.length >= 2;
            out.push(
                '<circle cx="' +
                    fmt(n.x) +
                    '" cy="' +
                    fmt(n.y) +
                    '" r="' +
                    (isInt ? dotrInt : dotR) +
                    '" fill="#ffffff" stroke="#2b2b2b" stroke-width="' +
                    (isInt ? 2 : 1.4) +
                    '"/>'
            );
        });

        // ---------- 站名 ----------
        placements.forEach(function (p) {
            out.push(
                '<text x="' +
                    fmt(p.textX) +
                    '" y="' +
                    fmt(p.textY) +
                    '" text-anchor="' +
                    p.anchor +
                    '" dominant-baseline="central" font-size="' +
                    fs +
                    '" fill="#2f3540" paint-order="stroke" stroke="#ffffff" stroke-width="3.2" stroke-linejoin="round">' +
                    esc(p.node.name) +
                    '</text>'
            );
        });

        // ---------- 图例 ----------
        if (legendW) {
            var lx = b.maxX + legendGap;
            var ly = vbMinY + 14;
            out.push(
                '<rect x="' +
                    fmt(lx - 12) +
                    '" y="' +
                    fmt(ly - 12) +
                    '" width="' +
                    fmt(legendW) +
                    '" height="' +
                    fmt(40 + map.lines.length * 24) +
                    '" rx="10" fill="#ffffff" stroke="#e5e7eb"/>'
            );
            out.push(
                '<text x="' +
                    fmt(lx) +
                    '" y="' +
                    fmt(ly + 8) +
                    '" font-size="14" font-weight="700" fill="#1f2430">线路图例</text>'
            );
            map.lines.forEach(function (line, i) {
                var yc = ly + 36 + i * 24;
                out.push(
                    '<line x1="' +
                        fmt(lx) +
                        '" y1="' +
                        fmt(yc) +
                        '" x2="' +
                        fmt(lx + 34) +
                        '" y2="' +
                        fmt(yc) +
                        '" stroke="' +
                        line.colorHex +
                        '" stroke-width="' +
                        fmt(lw - 1) +
                        '" stroke-linecap="round"/>'
                );
                out.push(
                    '<circle cx="' +
                        fmt(lx) +
                        '" cy="' +
                        fmt(yc) +
                        '" r="2.4" fill="#fff" stroke="#2b2b2b" stroke-width="1"/>'
                );
                out.push(
                    '<circle cx="' +
                        fmt(lx + 34) +
                        '" cy="' +
                        fmt(yc) +
                        '" r="2.4" fill="#fff" stroke="#2b2b2b" stroke-width="1"/>'
                );
                var label = clampText(line.name + ' · ' + line.stopCount + ' 站', legendW - 64, 12);
                out.push(
                    '<text x="' +
                        fmt(lx + 44) +
                        '" y="' +
                        fmt(yc) +
                        '" dominant-baseline="central" font-size="12" fill="#374151">' +
                        esc(label) +
                        '</text>'
                );
            });
        }

        // ---------- 比例尺 ----------
        if (opts.showScale !== false && map.unitsPerBlock > 0) {
            var blocks = MMS.geo.niceNumber(140 / map.unitsPerBlock);
            var barLen = blocks * map.unitsPerBlock;
            var sx = b.minX,
                sy = b.maxY + 24;
            out.push(
                '<line x1="' +
                    fmt(sx) +
                    '" y1="' +
                    fmt(sy) +
                    '" x2="' +
                    fmt(sx + barLen) +
                    '" y2="' +
                    fmt(sy) +
                    '" stroke="#374151" stroke-width="2"/>'
            );
            out.push(
                '<line x1="' +
                    fmt(sx) +
                    '" y1="' +
                    fmt(sy - 4) +
                    '" x2="' +
                    fmt(sx) +
                    '" y2="' +
                    fmt(sy + 4) +
                    '" stroke="#374151" stroke-width="2"/>'
            );
            out.push(
                '<line x1="' +
                    fmt(sx + barLen) +
                    '" y1="' +
                    fmt(sy - 4) +
                    '" x2="' +
                    fmt(sx + barLen) +
                    '" y2="' +
                    fmt(sy + 4) +
                    '" stroke="#374151" stroke-width="2"/>'
            );
            out.push(
                '<text x="' +
                    fmt(sx + barLen / 2) +
                    '" y="' +
                    fmt(sy - 7) +
                    '" text-anchor="middle" font-size="11" fill="#4b5563">' +
                    blocks +
                    ' 格</text>'
            );
        }

        // ---------- 指北针 ----------
        if (opts.showNorth !== false) {
            var nx = b.maxX - 10,
                ny = b.maxY + 30;
            out.push(
                '<path d="M' +
                    fmt(nx) +
                    ' ' +
                    fmt(ny - 16) +
                    ' l-6 12 h12 Z" fill="#374151"/>'
            );
            out.push(
                '<text x="' +
                    fmt(nx) +
                    '" y="' +
                    fmt(ny + 8) +
                    '" text-anchor="middle" font-size="11" font-weight="600" fill="#374151">N</text>'
            );
        }

        // ---------- 页脚 ----------
        if (opts.showFooter !== false) {
            var foot = '由 Metro 插件配置自动生成 · Metro 线网工坊';
            if (opts.dateText) foot += ' · ' + opts.dateText;
            out.push(
                '<text x="' +
                    fmt(vbMaxX - pad) +
                    '" y="' +
                    fmt(vbMaxY - 10) +
                    '" text-anchor="end" font-size="10" fill="#9ca3af">' +
                    esc(foot) +
                    '</text>'
            );
        }

        out.push('</svg>');
        return { svg: out.join(''), width: vw, height: vh, placements: placements };
    }

    MMS.render = { build: build };
})(typeof window !== 'undefined' ? window : globalThis);
