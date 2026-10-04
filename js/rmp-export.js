/*
 * rmp-export.js — 导出 Rail Map Painter（railmapgen.github.io/rmp）兼容存档。
 *
 * 存档结构对照 railmapgen/rmp 仓库（2026-10，版本号 80）：
 *   { version, mapEnabled, mapStyle, svgViewBoxZoom, svgViewBoxMin,
 *     graph: { options, attributes, nodes: [{key, attributes}], edges: [{key, source, target, attributes}] } }
 *
 * 车站：shmetro-basic（普通）/ shmetro-int（换乘）
 * 线路：single-color 样式 + simple（直线，带并行偏移）或 perpendicular（直角折线）路径
 */
(function (root) {
    'use strict';
    var MMS = (root.MMS = root.MMS || {});

    /** Rail Map Painter 当前存档版本（更新版本会自动执行升级链） */
    var RMP_SAVE_VERSION = 80;

    /** 与 RMP 默认地图样式一致，避免打开工程时字段缺失 */
    var DEFAULT_MAP_STYLE = {
        roads: {
            path: { enabled: true, casingColor: '#dedbd4', color: '#dedbd4', widthScale: 1 },
            local: { enabled: true, casingColor: '#cfd39c', color: '#fbf8d0', widthScale: 1 },
            collector: { enabled: true, casingColor: '#c8cf86', color: '#f7fabf', widthScale: 1 },
            arterial: { enabled: true, casingColor: '#d8ab62', color: '#f6d19b', widthScale: 1 }
        },
        rails: {
            metro: { enabled: true, color: '#4d8fd1', widthScale: 1 },
            national: { enabled: true, color: '#8f8a83', widthScale: 1 }
        },
        labels: {
            enabled: true,
            categories: {
                'place-major': { enabled: true, color: '#3a342d', strokeColor: '#f8f5ef', sizeScale: 1 },
                'place-medium': { enabled: true, color: '#4a443d', strokeColor: '#f8f5ef', sizeScale: 1 },
                'place-minor': { enabled: true, color: '#625c54', strokeColor: '#f8f5ef', sizeScale: 1 },
                'road-arterial': { enabled: true, color: '#554f48', strokeColor: '#f8f5ef', sizeScale: 1 },
                'road-collector': { enabled: true, color: '#68625a', strokeColor: '#f8f5ef', sizeScale: 1 },
                building: { enabled: true, color: '#726c64', strokeColor: '#f8f5ef', sizeScale: 1 },
                'area-water': { enabled: true, color: '#477285', strokeColor: '#f8f5ef', sizeScale: 1 },
                'area-park': { enabled: true, color: '#4f6f45', strokeColor: '#f8f5ef', sizeScale: 1 },
                'area-grass': { enabled: true, color: '#5f744e', strokeColor: '#f8f5ef', sizeScale: 1 },
                'area-forest': { enabled: true, color: '#4f6a43', strokeColor: '#f8f5ef', sizeScale: 1 },
                'area-farmland': { enabled: true, color: '#746d45', strokeColor: '#f8f5ef', sizeScale: 1 },
                'area-cemetery': { enabled: true, color: '#5e6f58', strokeColor: '#f8f5ef', sizeScale: 1 },
                'area-residential': { enabled: true, color: '#625c54', strokeColor: '#f8f5ef', sizeScale: 1 },
                'area-commercial': { enabled: true, color: '#795a5a', strokeColor: '#f8f5ef', sizeScale: 1 },
                'area-industrial': { enabled: true, color: '#675d75', strokeColor: '#f8f5ef', sizeScale: 1 },
                'area-education': { enabled: true, color: '#715f3b', strokeColor: '#f8f5ef', sizeScale: 1 },
                'area-healthcare': { enabled: true, color: '#7a5661', strokeColor: '#f8f5ef', sizeScale: 1 },
                'transport-airport': { enabled: true, color: '#3d6482', strokeColor: '#f8f5ef', sizeScale: 1 },
                'transport-rail': { enabled: true, color: '#3f3a34', strokeColor: '#f8f5ef', sizeScale: 1 },
                'transport-metro': { enabled: true, color: '#4d6c88', strokeColor: '#f8f5ef', sizeScale: 1 },
                'transport-platform': { enabled: true, color: '#655f58', strokeColor: '#f8f5ef', sizeScale: 1 },
                'transport-entrance': { enabled: true, color: '#6f8496', strokeColor: '#f8f5ef', sizeScale: 1 }
            }
        }
    };

    var ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

    /** FNV-1a 32 位哈希 → 确定性短 id（RMP 使用 nanoid 风格字符串） */
    function fnv1a(str) {
        var h = 0x811c9dc5;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        return h >>> 0;
    }

    function shortId(seed, used) {
        var h = fnv1a(seed);
        var s = '';
        for (var i = 0; i < 10; i++) {
            h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
            h = (h + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
            s += ID_CHARS[h % ID_CHARS.length];
        }
        var base = s;
        var k = 0;
        while (used.has(s)) {
            k++;
            s = base + k;
        }
        used.add(s);
        return s;
    }

    function round1(v) {
        return Math.round(v * 10) / 10;
    }

    function luminance(hex) {
        var m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
        if (!m) return 0.5;
        var r = parseInt(m[1].slice(0, 2), 16) / 255;
        var g = parseInt(m[1].slice(2, 4), 16) / 255;
        var b = parseInt(m[1].slice(4, 6), 16) / 255;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function offsetFromSide(side) {
        switch (side) {
            case 'left':
                return { x: 'left', y: 'middle' };
            case 'top':
                return { x: 'middle', y: 'top' };
            case 'bottom':
                return { x: 'middle', y: 'bottom' };
            default:
                return { x: 'right', y: 'middle' };
        }
    }

    /**
     * 构建 RMP 存档对象。
     * @param {Object} map geo.build() 结果
     * @param {Array}  placements MMS.geo.placeLabels / render.build 的站名摆放结果（可为 null）
     * @param {Object} opts { title, pathType: 'simple' | 'perpendicular' }
     * @returns {Object} 可直接 JSON.stringify 的存档对象
     */
    function build(map, placements, opts) {
        opts = opts || {};
        var pathType = opts.pathType === 'perpendicular' ? 'perpendicular' : 'simple';

        var usedNodeIds = new Set();
        var nodeKeyById = new Map();
        map.nodes.forEach(function (n) {
            nodeKeyById.set(n.id, 'stn_' + shortId(n.id + '|' + n.name + '|' + round1(n.wx), usedNodeIds));
        });

        var sideByNodeId = new Map();
        (placements || []).forEach(function (p) {
            sideByNodeId.set(p.node.id, p.side);
        });

        var nodes = map.nodes.map(function (n) {
            var isInt = n.lines.length >= 2;
            var off = offsetFromSide(sideByNodeId.get(n.id));
            var attrs = {
                visible: true,
                zIndex: 1,
                x: round1(n.x),
                y: round1(n.y)
            };
            if (isInt) {
                attrs.type = 'shmetro-int';
                attrs['shmetro-int'] = {
                    names: [n.name, ''],
                    nameOffsetX: off.x,
                    nameOffsetY: off.y,
                    rotate: 0,
                    height: 10,
                    width: 18
                };
            } else {
                attrs.type = 'shmetro-basic';
                attrs['shmetro-basic'] = {
                    names: [n.name, ''],
                    nameOffsetX: off.x,
                    nameOffsetY: off.y
                };
            }
            return { key: nodeKeyById.get(n.id), attributes: attrs };
        });

        var usedEdgeIds = new Set();
        var usedReconcile = new Set();
        var reconcileByLine = new Map();
        var edges = [];
        map.lines.forEach(function (line) {
            if (!reconcileByLine.has(line.id)) {
                reconcileByLine.set(line.id, shortId('rec|' + line.id + '|' + line.name, usedReconcile));
            }
            var reconcileId = reconcileByLine.get(line.id);
            var mono = luminance(line.colorHex) > 0.62 ? '#000' : '#fff';
            line.segments.forEach(function (seg, i) {
                if (seg.a === seg.b) return;
                var src = nodeKeyById.get(seg.a.id);
                var dst = nodeKeyById.get(seg.b.id);
                if (!src || !dst) return;
                var attrs = {
                    visible: true,
                    zIndex: 0,
                    type: pathType,
                    style: 'single-color',
                    reconcileId: reconcileId,
                    parallelIndex: -1
                };
                if (pathType === 'perpendicular') {
                    attrs.perpendicular = {
                        startFrom: 'from',
                        offsetFrom: 0,
                        offsetTo: 0,
                        roundCornerFactor: 18.33
                    };
                } else {
                    attrs.simple = { offset: round1(seg.offset) };
                }
                attrs['single-color'] = {
                    color: ['other', 'other', line.colorHex, mono]
                };
                edges.push({
                    key: 'line_' + shortId('e|' + line.id + '|' + seg.a.id + '|' + seg.b.id + '|' + i, usedEdgeIds),
                    source: src,
                    target: dst,
                    attributes: attrs
                });
            });
        });

        return {
            version: RMP_SAVE_VERSION,
            mapEnabled: false,
            mapStyle: DEFAULT_MAP_STYLE,
            svgViewBoxZoom: 100,
            svgViewBoxMin: {
                x: round1(map.bounds.minX - 40),
                y: round1(map.bounds.minY - 40)
            },
            graph: {
                options: { type: 'directed', multi: true, allowSelfLoops: true },
                attributes: { name: opts.title || '' },
                nodes: nodes,
                edges: edges
            }
        };
    }

    MMS.rmp = { build: build, RMP_SAVE_VERSION: RMP_SAVE_VERSION };
})(typeof window !== 'undefined' ? window : globalThis);
