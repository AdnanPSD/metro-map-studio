/*
 * geo.js — 几何引擎：
 *   1. 世界过滤 + 同名车站合并 → 节点
 *   2. 世界坐标 (x,z) → 图纸坐标投影（北朝上）
 *   3. 线路折线生成：
 *        real          —— 使用 lines.yml 里录制的 route_points（按段归属、跳跃断线）
 *        schematic     —— RDP 简化 + 45° 折线化（经典示意图风格）
 *        perpendicular —— 全部水平 / 垂直段 + 90° 直角转角（与 RMP perpendicular 一致）
 *   4. 并行区段（多条线走同一条轨道）横向偏移（与 Rail Map Painter 的 simple 路径公式一致）
 *   5. 自动配色：全部线路同色 / 白色时，按“线路组”（同一线路的上行下行视为一组）分配预览配色
 *   6. 站名自动摆放（碰撞避让）
 */
(function (root) {
    'use strict';
    var MMS = (root.MMS = root.MMS || {});

    /** 自动配色调色板（线路全部同色 / 白色时启用） */
    var AUTO_PALETTE = [
        '#E23B3B',
        '#1F6FD6',
        '#1EA26A',
        '#F08A24',
        '#8C5BD8',
        '#0FA3B1',
        '#D14FA0',
        '#7A8B99',
        '#B7A14A',
        '#5B6BD2',
        '#4C7A34',
        '#B4552D'
    ];

    /** 去掉“｜上行 / |下行”方向后缀，用于识别同一条线路的两个方向 */
    function baseStopName(name) {
        return String(name == null ? '' : name).replace(/[|｜]\s*(上行|下行)\s*$/, '');
    }

    function distW(ax, az, bx, bz) {
        var dx = ax - bx,
            dz = az - bz;
        return Math.sqrt(dx * dx + dz * dz);
    }

    /** RDP 折线简化（迭代实现，避免深递归） */
    function rdp(points, tol) {
        if (points.length < 3) return points.slice();
        var keep = new Array(points.length);
        for (var i = 0; i < keep.length; i++) keep[i] = false;
        keep[0] = keep[points.length - 1] = true;
        var stack = [[0, points.length - 1]];
        var tol2 = tol * tol;
        while (stack.length) {
            var seg = stack.pop();
            var i0 = seg[0],
                i1 = seg[1];
            var ax = points[i0].x,
                ay = points[i0].y;
            var bx = points[i1].x,
                by = points[i1].y;
            var dx = bx - ax,
                dy = by - ay;
            var l2 = dx * dx + dy * dy;
            var maxD = -1,
                maxI = -1;
            for (var k = i0 + 1; k < i1; k++) {
                var px = points[k].x - ax,
                    py = points[k].y - ay;
                var t = l2 > 0 ? (px * dx + py * dy) / l2 : 0;
                if (t < 0) t = 0;
                if (t > 1) t = 1;
                var ex = ax + t * dx - points[k].x,
                    ey = ay + t * dy - points[k].y;
                var d = ex * ex + ey * ey;
                if (d > maxD) {
                    maxD = d;
                    maxI = k;
                }
            }
            if (maxD > tol2 && maxI > 0) {
                keep[maxI] = true;
                stack.push([i0, maxI], [maxI, i1]);
            }
        }
        var out = [];
        for (var j = 0; j < points.length; j++) if (keep[j]) out.push(points[j]);
        return out;
    }

    /** 把一段折线分割成若干“45° + 直线”的子段（经典地铁示意图风格） */
    function octilinearize(points) {
        if (points.length < 2) return points.slice();
        var out = [points[0]];
        for (var i = 1; i < points.length; i++) {
            var a = out[out.length - 1];
            var b = points[i];
            var dx = b.x - a.x,
                dy = b.y - a.y;
            var adx = Math.abs(dx),
                ady = Math.abs(dy);
            if (adx < 0.4 && ady < 0.4) continue;
            var ang = (Math.atan2(ady, adx) * 180) / Math.PI; // 0..90
            if (ang < 8 || ang > 82 || Math.abs(ang - 45) < 8) {
                out.push(b);
                continue;
            }
            var sx = dx >= 0 ? 1 : -1;
            var sy = dy >= 0 ? 1 : -1;
            if (adx > ady) {
                // 对角段到 b 的 y，再水平段
                out.push({ x: a.x + sx * ady, y: b.y });
            } else {
                // 对角段到 b 的 x，再垂直段
                out.push({ x: b.x, y: a.y + sy * adx });
            }
            out.push(b);
        }
        return out;
    }

    /**
     * 直角折线化：从起点先水平走到终点的 x，再垂直进入终点，
     * 与 Rail Map Painter「perpendicular」在 startFrom: 'from'、无偏移时的路径一致。
     */
    function perpendicularize(a, b) {
        var out = [{ x: a.x, y: a.y }];
        var corner = { x: b.x, y: a.y };
        if (Math.abs(corner.x - out[0].x) > 0.01 || Math.abs(corner.y - out[0].y) > 0.01) out.push(corner);
        var last = out[out.length - 1];
        if (Math.abs(b.x - last.x) > 0.01 || Math.abs(b.y - last.y) > 0.01) out.push({ x: b.x, y: b.y });
        if (out.length < 2) out.push({ x: b.x, y: b.y });
        return out;
    }

    /**
     * 与 Rail Map Painter「simple」路径完全一致的横向偏移向量。
     * 这样本工具预览图与导出的 RMP 存档在直线段上视觉一致。
     */
    function rmpPerpShift(ax, ay, bx, by, offset) {
        var dx = bx - ax,
            dy = by - ay;
        if (Math.abs(dx) < 1e-6) return { x: offset, y: 0 }; // 垂直段
        if (Math.abs(dy) < 1e-6) return { x: 0, y: offset }; // 水平段
        var kk = Math.abs(dx / dy); // = 1/k
        var ddx = offset / Math.sqrt(kk * kk + 1);
        var ddy = ddx * kk * -Math.sign(dx * dy);
        return { x: ddx, y: ddy };
    }

    function cross(ax, ay, bx, by) {
        return ax * by - ay * bx;
    }

    function segmentIntersection(a, b, c, d) {
        var rx = b.x - a.x,
            ry = b.y - a.y,
            sx = d.x - c.x,
            sy = d.y - c.y;
        var denom = cross(rx, ry, sx, sy);
        if (Math.abs(denom) < 1e-7) return null;
        var qx = c.x - a.x,
            qy = c.y - a.y;
        var t = cross(qx, qy, sx, sy) / denom;
        var u = cross(qx, qy, rx, ry) / denom;
        if (t < -1e-5 || t > 1 + 1e-5 || u < -1e-5 || u > 1 + 1e-5) return null;
        return { x: a.x + t * rx, y: a.y + t * ry };
    }

    function detectCrossings(lines, nodes) {
        var edges = [];
        var lineOrder = new Map();
        lines.forEach(function (line, lineIndex) {
            lineOrder.set(line.id, lineIndex);
            line.segments.forEach(function (segment) {
                segment.parts.forEach(function (part) {
                    for (var i = 1; i < part.length; i++) {
                        var a = part[i - 1],
                            b = part[i];
                        edges.push({
                            line: line,
                            a: a,
                            b: b,
                            minX: Math.min(a.x, b.x),
                            maxX: Math.max(a.x, b.x),
                            minY: Math.min(a.y, b.y),
                            maxY: Math.max(a.y, b.y)
                        });
                    }
                });
            });
        });
        edges.sort(function (a, b) {
            return a.minX - b.minX;
        });

        var transferNodesByPair = new Map();
        nodes.forEach(function (node) {
            if (node.lines.length < 2) return;
            for (var i = 0; i < node.lines.length; i++) {
                for (var j = i + 1; j < node.lines.length; j++) {
                    var pair = [node.lines[i], node.lines[j]].sort().join('|');
                    if (!transferNodesByPair.has(pair)) transferNodesByPair.set(pair, []);
                    transferNodesByPair.get(pair).push(node);
                }
            }
        });

        var crossings = [];
        var seen = new Set();
        var active = [];
        edges.forEach(function (edge) {
            active = active.filter(function (candidate) {
                return candidate.maxX >= edge.minX - 1e-5;
            });
            active.forEach(function (candidate) {
                var a = candidate,
                    b = edge;
                if (a.line.id === b.line.id) return;
                if (a.maxY < b.minY - 1e-5 || b.maxY < a.minY - 1e-5) return;
                var point = segmentIntersection(a.a, a.b, b.a, b.b);
                if (!point) return;

                var pair = [a.line.id, b.line.id].sort().join('|');
                var isTransfer = (transferNodesByPair.get(pair) || []).some(function (node) {
                    return Math.hypot(node.x - point.x, node.y - point.y) < 2;
                });
                if (isTransfer) return;

                var crossingKey = pair + '|' + Math.round(point.x * 100) + '|' + Math.round(point.y * 100);
                if (seen.has(crossingKey)) return;
                seen.add(crossingKey);

                var under = lineOrder.get(a.line.id) < lineOrder.get(b.line.id) ? a : b;
                var over = under === a ? b : a;

                crossings.push({
                    x: point.x,
                    y: point.y,
                    under: { lineId: under.line.id, a: under.a, b: under.b },
                    over: { lineId: over.line.id, colorHex: over.line.colorHex, a: over.a, b: over.b }
                });
            });
            active.push(edge);
        });
        return crossings;
    }

    /** 文本宽度估算（CJK / 拉丁混排） */
    function textWidth(t, fs) {
        var w = 0;
        for (var i = 0; i < t.length; i++) {
            var ch = t[i];
            var code = ch.charCodeAt(0);
            if (code >= 0x2e80) w += fs * 1.0;
            else if (/[A-Za-z0-9]/.test(ch)) w += fs * 0.58;
            else if (ch === ' ') w += fs * 0.32;
            else w += fs * 0.45;
        }
        return w;
    }

    function niceNumber(v) {
        var cands = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
        var best = cands[0],
            bestD = Infinity;
        for (var i = 0; i < cands.length; i++) {
            var d = Math.abs(cands[i] - v);
            if (d < bestD) {
                bestD = d;
                best = cands[i];
            }
        }
        return best;
    }

    /**
     * 构建地图模型。
     * @param {Object} model parse() 的返回值
     * @param {Object} opts  { world, mergeByName, mode, parallelSpacing, targetSize, simplifyTolerance }
     */
    function build(model, opts) {
        opts = opts || {};
        var warnings = [];
        var translate = typeof opts.translate === 'function' ? opts.translate : null;
        function message(key, params, fallback) {
            return translate ? translate(key, params) : fallback;
        }
        var mode =
            opts.mode === 'schematic' ? 'schematic' : opts.mode === 'perpendicular' ? 'perpendicular' : 'real';
        var mergeByName = opts.mergeByName !== false;
        var targetSize = opts.targetSize || 1100;
        var spacing = opts.parallelSpacing || 10;
        var simplifyTol = opts.simplifyTolerance || 16;

        // ---------- 1. 仅保留线路实际引用的停靠区 ----------
        var routedStopIds = new Set();
        model.lines.forEach(function (line) {
            line.stopIds.forEach(function (stopId) {
                if (model.stops.has(stopId)) routedStopIds.add(stopId);
            });
        });
        var routedStops = [];
        model.stops.forEach(function (stop) {
            if (routedStopIds.has(stop.id)) routedStops.push(stop);
        });
        var orphanStopCount = model.stops.size - routedStops.length;
        if (orphanStopCount > 0) {
            warnings.push(message('warnOrphanStops', { count: orphanStopCount }, orphanStopCount + ' 个停靠区未被任何线路引用，已忽略。'));
        }

        // ---------- 2. 世界选择 ----------
        var worldCount = new Map();
        routedStops.forEach(function (s) {
            worldCount.set(s.world, (worldCount.get(s.world) || 0) + 1);
        });
        var worlds = [];
        worldCount.forEach(function (count, name) {
            worlds.push({ name: name, count: count });
        });
        worlds.sort(function (a, b) {
            return b.count - a.count;
        });
        if (!worlds.length) {
            return emptyMap(worlds, warnings, message);
        }
        var world = opts.world && worldCount.has(opts.world) ? opts.world : worlds[0].name;

        var usableStops = [];
        var skippedWorld = 0;
        routedStops.forEach(function (s) {
            if (s.world === world) usableStops.push(s);
            else skippedWorld++;
        });
        if (skippedWorld > 0) {
            warnings.push(message(
                'warnSelectedWorld',
                { world: world, count: skippedWorld },
                '已选择世界 “' + world + '”，另有 ' + skippedWorld + ' 个停靠区位于其他世界，未参与绘制。'
            ));
        }

        // ---------- 2. 同名车站合并 ----------
        var groups = new Map();
        usableStops.forEach(function (s) {
            var key = mergeByName ? s.name : s.id;
            if (!groups.has(key)) {
                groups.set(key, { name: s.name, members: [] });
            }
            groups.get(key).members.push(s);
        });
        var mergedGroupCount = 0;
        groups.forEach(function (g) {
            if (g.members.length > 1) mergedGroupCount++;
        });

        var nodes = [];
        var nodesById = new Map(); // merge key -> node
        groups.forEach(function (g, key) {
            var wx = 0,
                wz = 0,
                wy = 0;
            var hasPoint = false;
            g.members.forEach(function (m) {
                wx += m.x;
                wz += m.z;
                wy += m.y;
                if (m.posSource === 'point') hasPoint = true;
            });
            var node = {
                id: 'n' + nodes.length,
                name: g.name,
                members: g.members.map(function (m) {
                    return m.id;
                }),
                wx: wx / g.members.length,
                wz: wz / g.members.length,
                wy: wy / g.members.length,
                hasPoint: hasPoint,
                lines: [],
                x: 0,
                y: 0,
                dirSumX: 0,
                dirSumY: 0,
                dirCount: 0
            };
            nodes.push(node);
            nodesById.set(key, node);
        });

        // ---------- 3. 投影 ----------
        var minWX = Infinity,
            maxWX = -Infinity,
            minWZ = Infinity,
            maxWZ = -Infinity;
        nodes.forEach(function (n) {
            if (n.wx < minWX) minWX = n.wx;
            if (n.wx > maxWX) maxWX = n.wx;
            if (n.wz < minWZ) minWZ = n.wz;
            if (n.wz > maxWZ) maxWZ = n.wz;
        });
        var spanX = maxWX - minWX,
            spanZ = maxWZ - minWZ;
        var maxSpan = Math.max(spanX, spanZ);
        var scale = maxSpan > 0.5 ? Math.min(targetSize / maxSpan, 22) : 18;
        var cx = (minWX + maxWX) / 2,
            cz = (minWZ + maxWZ) / 2;

        function toDiagramX(wx) {
            return (wx - cx) * scale;
        }
        function toDiagramY(wz) {
            return (wz - cz) * scale; // +z 在南 → 屏幕上朝下，北朝上
        }

        nodes.forEach(function (n) {
            n.x = toDiagramX(n.wx);
            n.y = toDiagramY(n.wz);
        });

        // ---------- 4. 线路折线 ----------
        var linesData = [];
        model.lines.forEach(function (line) {
            var seq = [];
            line.stopIds.forEach(function (sid) {
                var s = model.stops.get(sid);
                if (!s || s.world !== world) return;
                var key = mergeByName ? s.name : s.id;
                var node = nodesById.get(key);
                if (!node) return;
                if (seq.length && seq[seq.length - 1] === node) return; // 连续重复
                seq.push(node);
            });
            if (seq.length < 2) {
                warnings.push(message(
                    'warnTooFewStations',
                    { line: line.name },
                    '线路 “' + line.name + '” 在当前世界可用停靠区不足 2 个，已跳过绘制。'
                ));
                return;
            }
            seq.forEach(function (n) {
                if (n.lines.indexOf(line.id) < 0) n.lines.push(line.id);
            });

            // 录制的轨迹点（仅当前世界）
            var routeW = [];
            line.routePoints.forEach(function (p) {
                if (p.world === world) routeW.push(p);
            });
            if (routeW.length > 12000) {
                var stride = Math.ceil(routeW.length / 12000);
                var sampled = [];
                for (var q = 0; q < routeW.length; q += stride) sampled.push(routeW[q]);
                routeW = sampled;
            }

            var segments = [];
            for (var i = 0; i < seq.length - 1; i++) {
                var a = seq[i],
                    b = seq[i + 1];
                var len = distW(a.wx, a.wz, b.wx, b.wz);
                var parts = [];

                if (mode === 'real' && routeW.length > 1) {
                    parts = bucketRoutePoints(a, b, routeW, toDiagramX, toDiagramY);
                    if (parts.totalAccepted < parts.pointCount * 0.2 && parts.pointCount > 40 && !line._rpWarned) {
                        line._rpWarned = true;
                        warnings_push(warnings, message(
                            'warnRouteDeviation',
                            { line: line.name, accepted: parts.totalAccepted, total: parts.pointCount },
                            '线路 “' + line.name + '” 的录制轨迹与站台位置偏差较大（仅 ' + parts.totalAccepted + '/' + parts.pointCount + ' 个轨迹点被采用），该线路可能未按最新站位重新录制（/m line recordroute）。'
                        ));
                    }
                } else {
                    parts.raw = true; // 标记：来自直连或简化
                    parts.parts = [[{ x: a.x, y: a.y }, { x: b.x, y: b.y }]];
                }

                // 模式处理
                var processed = parts.parts;
                if (mode === 'real') {
                    processed = processed.map(function (p) {
                        return rdp(p, 0.9);
                    });
                } else if (mode === 'perpendicular') {
                    processed = processed.map(function (p) {
                        return perpendicularize(p[0], p[p.length - 1]);
                    });
                } else {
                    processed = processed.map(function (p) {
                        var simplified = rdp(p, simplifyTol);
                        // 控制顶点数量，避免锯齿
                        var guard = 0;
                        while (simplified.length > 24 && guard < 6) {
                            simplified = rdp(simplified, simplifyTol * (guard + 2));
                            guard++;
                        }
                        return octilinearize(simplified);
                    });
                }

                // 方向统计（用于站名侧向判断）
                var dx = b.x - a.x,
                    dy = b.y - a.y,
                    l = Math.sqrt(dx * dx + dy * dy) || 1;
                a.dirSumX += dx / l;
                a.dirSumY += dy / l;
                a.dirCount++;
                b.dirSumX -= dx / l;
                b.dirSumY -= dy / l;
                b.dirCount++;

                segments.push({
                    a: a,
                    b: b,
                    key: a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id,
                    length: len,
                    offset: 0,
                    parts: processed
                });
            }

            var stopKey = seq
                .map(function (n) {
                    return baseStopName(n.name);
                })
                .sort()
                .join('|');

            linesData.push({
                id: line.id,
                name: line.name,
                colorHex: line.colorHex,
                colorRaw: line.colorRaw,
                stopKey: stopKey,
                nodeIds: seq.map(function (n) {
                    return n.id;
                }),
                segments: segments,
                hasRoute: routeW.length > 1 && mode === 'real',
                stopCount: seq.length
            });
        });

        // ---------- 5. 并行区段偏移 ----------
        var groupMap = new Map();
        linesData.forEach(function (line) {
            line.segments.forEach(function (seg) {
                if (!groupMap.has(seg.key)) groupMap.set(seg.key, []);
                groupMap.get(seg.key).push(seg);
            });
        });
        groupMap.forEach(function (list) {
            if (list.length < 2) return;
            var n = list.length;
            for (var i = 0; i < n; i++) {
                var off = (i - (n - 1) / 2) * spacing;
                var seg = list[i];
                seg.offset = off;
                if (Math.abs(off) < 1e-6) continue;
                var shift = rmpPerpShift(seg.a.x, seg.a.y, seg.b.x, seg.b.y, off);
                seg.parts = seg.parts.map(function (part) {
                    return part.map(function (p) {
                        return { x: p.x + shift.x, y: p.y + shift.y };
                    });
                });
            }
        });

        // ---------- 5.5 自动配色（全部线路同色 / 白色时，按线路组分配） ----------
        if (opts.autoColor !== false && linesData.length >= 2) {
            var distinctColors = {};
            linesData.forEach(function (l) {
                distinctColors[l.colorHex] = 1;
            });
            if (Object.keys(distinctColors).length < 2) {
                var colorByGroup = {};
                var paletteIndex = 0;
                linesData.forEach(function (l) {
                    if (!colorByGroup[l.stopKey]) {
                        colorByGroup[l.stopKey] = AUTO_PALETTE[paletteIndex % AUTO_PALETTE.length];
                        paletteIndex++;
                    }
                    l.colorHex = colorByGroup[l.stopKey];
                    l.autoColor = true;
                });
                warnings.push(message(
                    'warnAutoColors',
                    { count: linesData.length, groups: paletteIndex },
                    '全部 ' +
                        linesData.length +
                        ' 条线路的颜色相同（或为默认白色），已按 ' +
                        paletteIndex +
                        ' 组线路自动分配预览配色；左侧“自动配色”选项可关闭，此调整不影响服务器配置文件。'
                ));
            }
        }

        // ---------- 6. 包围盒 ----------
        var minX = Infinity,
            maxX = -Infinity,
            minY = Infinity,
            maxY = -Infinity;
        nodes.forEach(function (n) {
            if (n.x < minX) minX = n.x;
            if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.y > maxY) maxY = n.y;
        });
        linesData.forEach(function (line) {
            line.segments.forEach(function (seg) {
                seg.parts.forEach(function (part) {
                    part.forEach(function (p) {
                        if (!isFinite(p.x) || !isFinite(p.y)) return;
                        if (p.x < minX) minX = p.x;
                        if (p.x > maxX) maxX = p.x;
                        if (p.y < minY) minY = p.y;
                        if (p.y > maxY) maxY = p.y;
                    });
                });
            });
        });
        if (!isFinite(minX)) {
            minX = maxX = minY = maxY = 0;
        }

        var activeLineIds = new Set();
        linesData.forEach(function (line) {
            activeLineIds.add(line.id);
        });
        nodes.forEach(function (node) {
            node.members.forEach(function (stopId) {
                var stop = model.stops.get(stopId);
                (stop ? stop.transferableLines : []).forEach(function (lineId) {
                    if (activeLineIds.has(lineId) && node.lines.indexOf(lineId) < 0) node.lines.push(lineId);
                });
            });
        });

        var transferCount = 0;
        nodes.forEach(function (n) {
            n.isTransfer = n.lines.length >= 2;
            if (n.isTransfer) transferCount++;
        });
        var transferStations = nodes.filter(function (n) {
            return n.isTransfer;
        });
        var crossings = detectCrossings(linesData, nodes);
        if (crossings.length) {
            warnings.push(message(
                'warnCrossings',
                { count: crossings.length },
                '检测到 ' + crossings.length + ' 处非换乘线路交叉，已用断线跨越符号区分；交叉处不代表换乘。'
            ));
        }
        var cornerStops = 0;
        usableStops.forEach(function (s) {
            if (s.posSource === 'corner') cornerStops++;
        });
        if (cornerStops > 0) {
            warnings.push(message(
                'warnCornerStops',
                { count: cornerStops },
                '有 ' + cornerStops + ' 个停靠区缺少 stoppoint（未设置停靠点），位置按 corner 区域中心估算。'
            ));
        }

        return {
            world: world,
            worlds: worlds,
            nodes: nodes,
            lines: linesData,
            crossings: crossings,
            transferStations: transferStations,
            bounds: { minX: minX, minY: minY, maxX: maxX, maxY: maxY },
            unitsPerBlock: scale,
            mode: mode,
            warnings: warnings,
            stats: {
                stopCount: usableStops.length,
                nodeCount: nodes.length,
                lineCount: linesData.length,
                transferCount: transferCount,
                crossingCount: crossings.length,
                mergedGroupCount: mergedGroupCount,
                cornerStops: cornerStops,
                orphanStopCount: orphanStopCount
            }
        };
    }

    function warnings_push(arr, msg) {
        arr.push(msg);
    }

    function emptyMap(worlds, warnings, message) {
        warnings.push(message(
            'warnNoCoordinates',
            {},
            '没有解析到任何带坐标的停靠区，请检查 stops.yml。'
        ));
        return {
            world: null,
            worlds: worlds,
            nodes: [],
            lines: [],
            crossings: [],
            transferStations: [],
            bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
            unitsPerBlock: 1,
            mode: 'real',
            warnings: warnings,
            stats: {
                stopCount: 0,
                nodeCount: 0,
                lineCount: 0,
                transferCount: 0,
                crossingCount: 0,
                mergedGroupCount: 0,
                cornerStops: 0,
                orphanStopCount: 0
            }
        };
    }

    /**
     * 将录制轨迹点按“最近的区段”归类到某段线路上，并按行进方向排序。
     * 返回 { parts: [[{x,y}...]...], totalAccepted, pointCount }（图纸坐标）
     */
    function bucketRoutePoints(a, b, routeW, toDiagramX, toDiagramY) {
        var dx = b.wx - a.wx,
            dz = b.wz - a.wz;
        var len2 = dx * dx + dz * dz;
        var len = Math.sqrt(len2);
        if (len < 1e-6) {
            return { parts: [[{ x: a.x, y: a.y }, { x: b.x, y: b.y }]], totalAccepted: 0, pointCount: routeW.length };
        }
        var maxDist = Math.max(len * 0.55, 48);
        var bucket = [];
        for (var i = 0; i < routeW.length; i++) {
            var p = routeW[i];
            var t = ((p.x - a.wx) * dx + (p.z - a.wz) * dz) / len2;
            if (t <= 0.02 || t >= 0.98) continue;
            var px = a.wx + t * dx,
                pz = a.wz + t * dz;
            var d = Math.sqrt((p.x - px) * (p.x - px) + (p.z - pz) * (p.z - pz));
            if (d > maxDist) continue;
            bucket.push({ t: t, p: p });
        }
        bucket.sort(function (m, n) {
            return m.t - n.t;
        });

        var parts = [];
        var cur = [{ x: a.x, y: a.y }];
        var last = { x: a.wx, z: a.wz };
        var accepted = 0;
        for (var k = 0; k < bucket.length; k++) {
            var bp = bucket[k].p;
            var jd = distW(last.x, last.z, bp.x, bp.z);
            if (jd > 64) {
                // 录制中断/传送门 → 断开
                parts.push(cur);
                cur = [];
            } else if (jd < 1.5) {
                continue; // 太近的点丢弃
            }
            cur.push({ x: toDiagramX(bp.x), y: toDiagramY(bp.z) });
            last = { x: bp.x, z: bp.z };
            accepted++;
        }
        cur.push({ x: b.x, y: b.y });
        parts.push(cur);
        return { parts: parts, totalAccepted: accepted, pointCount: routeW.length };
    }

    /**
     * 站名自动摆放：按 [右/左/上/下] 优先级尝试，做矩形碰撞避让。
     * @returns [{ node, side, rect, textX, textY, anchor }]
     */
    function placeLabels(map, opts) {
        opts = opts || {};
        var fs = opts.fontSize || 12;
        var r = opts.dotRadius || 5;
        var lineClearance = Math.max((opts.lineWidth || 7) / 2 + 2, 4);
        var occupied = (opts.excludedRects || []).map(function (rc) {
            return { x: rc.x, y: rc.y, w: rc.w, h: rc.h };
        });
        var lineSegments = [];
        map.lines.forEach(function (line) {
            line.segments.forEach(function (segment) {
                segment.parts.forEach(function (part) {
                    for (var i = 1; i < part.length; i++) {
                        lineSegments.push({ a: part[i - 1], b: part[i] });
                    }
                });
            });
        });
        map.nodes.forEach(function (n) {
            occupied.push({ x: n.x - r - 1.5, y: n.y - r - 1.5, w: 2 * r + 3, h: 2 * r + 3 });
        });

        var bounds = map.bounds;
        var spanX = Math.max(bounds.maxX - bounds.minX, 1);
        var spanY = Math.max(bounds.maxY - bounds.minY, 1);

        var order = map.nodes.slice().sort(function (p, q) {
            return q.lines.length - p.lines.length || textWidth(q.name, fs) - textWidth(p.name, fs);
        });

        var placements = [];
        order.forEach(function (node) {
            var name = node.name || '';
            if (!name) return;
            var w = textWidth(name, fs) + 1;
            var h = fs * 1.35;

            var leftEdge = node.x < bounds.minX + spanX * 0.12;
            var rightEdge = node.x > bounds.maxX - spanX * 0.12;
            var topEdge = node.y < bounds.minY + spanY * 0.12;
            var botEdge = node.y > bounds.maxY - spanY * 0.12;

            var cands = ['right', 'top', 'bottom', 'left'];
            if (leftEdge && !rightEdge) cands = ['right', 'top', 'bottom', 'left'];
            else if (rightEdge && !leftEdge) cands = ['left', 'top', 'bottom', 'right'];
            else if (topEdge && !botEdge) cands = ['bottom', 'right', 'left', 'top'];
            else if (botEdge && !topEdge) cands = ['top', 'right', 'left', 'bottom'];
            else if (node.dirCount > 0) {
                if (node.dirSumX >= node.dirCount * 0.55) cands = ['left', 'top', 'bottom', 'right'];
                else if (node.dirSumX <= -node.dirCount * 0.55) cands = ['right', 'top', 'bottom', 'left'];
                else if (node.dirSumY <= -node.dirCount * 0.55) cands = ['bottom', 'right', 'left', 'top'];
            }

            var best = null,
                bestOv = Infinity;
            for (var ci = 0; ci < cands.length; ci++) {
                var gaps = [5, 12, 22, 36, 54];
                for (var gi = 0; gi < gaps.length; gi++) {
                    var cand = rectFor(node, cands[ci], w, h, r, gaps[gi]);
                    var lineHits = countLineHits(cand, lineSegments, lineClearance);
                    var ov = overlapArea(cand, occupied) + lineHits * w * h * 10;
                    if (ov <= 0.5) {
                        best = cand;
                        bestOv = 0;
                        break;
                    }
                    if (ov < bestOv) {
                        bestOv = ov;
                        best = cand;
                    }
                }
                if (bestOv <= 0.5) break;
            }
            occupied.push({ x: best.x, y: best.y, w: best.w, h: best.h });
            best.node = node;
            placements.push(best);
        });
        return placements;
    }

    function countLineHits(rect, segments, padding) {
        var expanded = {
            left: rect.x - padding,
            right: rect.x + rect.w + padding,
            top: rect.y - padding,
            bottom: rect.y + rect.h + padding
        };
        var count = 0;
        segments.forEach(function (segment) {
            var dx = segment.b.x - segment.a.x,
                dy = segment.b.y - segment.a.y;
            var t0 = 0,
                t1 = 1;
            var p = [-dx, dx, -dy, dy];
            var q = [segment.a.x - expanded.left, expanded.right - segment.a.x, segment.a.y - expanded.top, expanded.bottom - segment.a.y];
            for (var i = 0; i < 4; i++) {
                if (Math.abs(p[i]) < 1e-8) {
                    if (q[i] < 0) return;
                    continue;
                }
                var t = q[i] / p[i];
                if (p[i] < 0) t0 = Math.max(t0, t);
                else t1 = Math.min(t1, t);
                if (t0 > t1) return;
            }
            count++;
        });
        return count;
    }

    function rectFor(node, side, w, h, r, gap) {
        if (side === 'right') {
            var x = node.x + r + gap;
            return {
                node: node,
                side: side,
                x: x,
                y: node.y - h / 2,
                w: w,
                h: h,
                textX: x,
                textY: node.y,
                anchor: 'start'
            };
        }
        if (side === 'left') {
            var x2 = node.x - r - gap;
            return {
                node: node,
                side: side,
                x: x2 - w,
                y: node.y - h / 2,
                w: w,
                h: h,
                textX: x2,
                textY: node.y,
                anchor: 'end'
            };
        }
        if (side === 'top') {
            return {
                node: node,
                side: side,
                x: node.x - w / 2,
                y: node.y - r - gap + 1 - h,
                w: w,
                h: h,
                textX: node.x,
                textY: node.y - r - gap + 1 - h / 2,
                anchor: 'middle'
            };
        }
        // bottom
        return {
            node: node,
            side: 'bottom',
            x: node.x - w / 2,
                y: node.y + r + gap - 1,
            w: w,
            h: h,
            textX: node.x,
                textY: node.y + r + gap - 1 + h / 2,
            anchor: 'middle'
        };
    }

    function overlapArea(rc, list) {
        var total = 0;
        for (var i = 0; i < list.length; i++) {
            var o = list[i];
            var ix = Math.max(0, Math.min(rc.x + rc.w, o.x + o.w) - Math.max(rc.x, o.x));
            var iy = Math.max(0, Math.min(rc.y + rc.h, o.y + o.h) - Math.max(rc.y, o.y));
            total += ix * iy;
            if (total > 1e6) break;
        }
        return total;
    }

    MMS.geo = {
        build: build,
        placeLabels: placeLabels,
        rmpPerpShift: rmpPerpShift,
        textWidth: textWidth,
        niceNumber: niceNumber,
        rdp: rdp,
        octilinearize: octilinearize
    };
})(typeof window !== 'undefined' ? window : globalThis);
