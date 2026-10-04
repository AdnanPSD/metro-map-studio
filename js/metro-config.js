/*
 * metro-config.js — 解析 Minecraft「Metro」插件配置（CubeX-MC/Metro）。
 *
 * 数据来源：
 *   plugins/Metro/lines.yml  线路：name / color / ordered_stop_ids / route_points ...
 *   plugins/Metro/stops.yml  停靠区：display_name / corner1_location / stoppoint_location ...
 *
 * 同时兼容新旧两代键名：
 *   旧（1.1.x）：name / corner1 / corner2 / stopPoint / launchYaw / ordered_platform_ids
 *   新（main）：display_name / corner1_location / corner2_location / stoppoint_location / launch_yaw / ordered_stop_ids
 */
(function (root) {
    'use strict';
    var MMS = (root.MMS = root.MMS || {});

    /** Minecraft 传统颜色代码 → RGB（与游戏内译码一致） */
    var LEGACY_COLORS = {
        '0': '#000000',
        '1': '#0000AA',
        '2': '#00AA00',
        '3': '#00AAAA',
        '4': '#AA0000',
        '5': '#AA00AA',
        '6': '#FFAA00',
        '7': '#AAAAAA',
        '8': '#555555',
        '9': '#5555FF',
        a: '#55FF55',
        b: '#55FFFF',
        c: '#FF5555',
        d: '#FF55FF',
        e: '#FFFF55',
        f: '#FFFFFF'
    };

    /**
     * 将 Metro 线路颜色字符串转为 #RRGGBB。
     * 支持 `&#RRGGBB`、传统 `&0`-`&f`、`&x&r&r&g&g&b&b`，解析失败返回 null。
     */
    function mcColorToHex(raw) {
        if (raw == null) return null;
        var s = String(raw).trim();
        if (!s) return null;
        var m = s.match(/^&#([0-9a-fA-F]{6})$/);
        if (m) return '#' + m[1].toUpperCase();
        m = s.match(/^&[xX](&[0-9a-fA-F]){6}$/);
        if (m) {
            var digits = s.match(/[0-9a-fA-F]/g).join('');
            return '#' + digits.toUpperCase();
        }
        m = s.match(/^&([0-9a-fA-F])$/);
        if (m) {
            var v = LEGACY_COLORS[m[1].toLowerCase()];
            if (v) return v;
        }
        m = s.match(/^#([0-9a-fA-F]{6})$/);
        if (m) return '#' + m[1].toUpperCase();
        return null;
    }

    /**
     * 解析 Bukkit 位置字符串 "world,x,y,z"。
     * 世界名里若含逗号（罕见）按“最后三个字段为坐标”容错。
     */
    function parseLocation(value) {
        if (value == null) return null;
        var s = String(value).trim();
        if (!s || s.toLowerCase() === 'none' || s.toLowerCase() === 'null') return null;
        var parts = s.split(',');
        if (parts.length < 4) return null;
        var z = Number(parts[parts.length - 1]);
        var y = Number(parts[parts.length - 2]);
        var x = Number(parts[parts.length - 3]);
        var world = parts.slice(0, parts.length - 3).join(',').trim();
        if (!world || !isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
        return { world: world, x: x, y: y, z: z };
    }

    function asStringArray(v) {
        if (v == null) return [];
        if (Array.isArray(v)) {
            return v
                .filter(function (t) {
                    return t != null && String(t).trim() !== '';
                })
                .map(function (t) {
                    return String(t).trim();
                });
        }
        var s = String(v).trim();
        return s ? [s] : [];
    }

    function pick(obj, keys) {
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (obj[k] != null && obj[k] !== '') return obj[k];
        }
        return null;
    }

    /**
     * 解析 lines.yml + stops.yml。
     * @param {string} linesText
     * @param {string} stopsText
     * @returns {{lines: Array, stops: Map, warnings: Array, stats: Object}}
     */
    function parse(linesText, stopsText) {
        var warnings = [];
        var stopsDoc = {};
        var linesDoc = {};

        try {
            stopsDoc = MMS.yaml.parse(stopsText || '');
        } catch (e) {
            throw new Error('stops.yml 解析失败：' + e.message);
        }
        try {
            linesDoc = MMS.yaml.parse(linesText || '');
        } catch (e) {
            throw new Error('lines.yml 解析失败：' + e.message);
        }

        var stops = new Map();
        Object.keys(stopsDoc).forEach(function (id) {
            if (id === 'schema_version') return;
            var sec = stopsDoc[id];
            if (sec == null || typeof sec !== 'object') {
                warnings.push('停靠区 “' + id + '” 内容为空，已跳过。');
                return;
            }
            var name = pick(sec, ['display_name', 'name']);
            name = name == null ? id : String(name);

            var pos = parseLocation(pick(sec, ['stoppoint_location', 'stopPoint', 'stop_point', 'stopPointLocation']));
            var source = 'point';
            if (!pos) {
                var c1 = parseLocation(pick(sec, ['corner1_location', 'corner1']));
                var c2 = parseLocation(pick(sec, ['corner2_location', 'corner2']));
                if (c1 && c2 && c1.world === c2.world) {
                    pos = {
                        world: c1.world,
                        x: (c1.x + c2.x) / 2,
                        y: (c1.y + c2.y) / 2,
                        z: (c1.z + c2.z) / 2
                    };
                    source = 'corner';
                }
            }
            if (!pos) {
                warnings.push('停靠区 “' + id + '”（' + name + '）没有可用坐标（缺 stoppoint / corner），已跳过。');
                return;
            }
            stops.set(id, {
                id: id,
                name: name,
                world: pos.world,
                x: pos.x,
                y: pos.y,
                z: pos.z,
                posSource: source,
                transferableLines: asStringArray(sec.transferable_lines)
            });
        });

        var lines = [];
        Object.keys(linesDoc).forEach(function (id) {
            if (id === 'schema_version') return;
            var sec = linesDoc[id];
            if (sec == null || typeof sec !== 'object') return;

            var name = pick(sec, ['name']);
            name = name == null ? id : String(name);
            var rawColor = pick(sec, ['color']) || '&f';
            var colorHex = mcColorToHex(rawColor) || '#8899AA';

            var stopIds = asStringArray(
                pick(sec, ['ordered_stop_ids', 'ordered_platform_ids', 'stop_ids', 'stops'])
            );
            var routePoints = [];
            asStringArray(pick(sec, ['route_points'])).forEach(function (rp) {
                var loc = parseLocation(rp);
                if (loc) routePoints.push(loc);
            });
            if (stopIds.length === 0) {
                warnings.push('线路 “' + id + '”（' + name + '）没有停靠区列表，已跳过。');
                return;
            }
            var missing = stopIds.filter(function (sid) {
                return !stops.has(sid);
            });
            if (missing.length) {
                warnings.push(
                    '线路 “' + id + '” 引用了不存在的停靠区：' + missing.join('、') + '（已从该线路中忽略）。'
                );
            }
            lines.push({
                id: id,
                name: name,
                colorRaw: String(rawColor),
                colorHex: colorHex,
                stopIds: stopIds,
                routePoints: routePoints,
                terminusName: pick(sec, ['terminus_name']) || ''
            });
        });

        return {
            lines: lines,
            stops: stops,
            warnings: warnings,
            stats: {
                lineCount: lines.length,
                stopCount: stops.size,
                routeLineCount: lines.filter(function (l) {
                    return l.routePoints.length > 1;
                }).length
            }
        };
    }

    MMS.metro = {
        parse: parse,
        parseLocation: parseLocation,
        mcColorToHex: mcColorToHex,
        LEGACY_COLORS: LEGACY_COLORS
    };
})(typeof window !== 'undefined' ? window : globalThis);
