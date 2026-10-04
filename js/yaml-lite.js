/*
 * yaml-lite.js — 针对 Minecraft 插件配置（YAML 子集）的轻量解析器。
 *
 * 支持的语法（覆盖 Bukkit YamlConfiguration 生成的常见结构）：
 *   - 注释：行首 # 或前面是空白的 #（注意：`&#00FF00` 不会被当作注释）
 *   - '单引号' 与 "双引号" 标量（含 '' 转义与 \" \\ 转义）
 *   - 嵌套映射（按缩进）
 *   - 块列表（`- item`，支持与父键同缩进的 Bukkit / SnakeYAML 输出风格）
 *   - 行内数组 [a, b, c]（容错支持）
 *
 * 不支持的语法（本项目用不到）：锚点/别名、多行字符串、流式映射、复杂列表项。
 */
(function (root) {
    'use strict';
    var MMS = (root.MMS = root.MMS || {});

    function stripComment(line) {
        var inS = false,
            inD = false;
        for (var i = 0; i < line.length; i++) {
            var c = line[i];
            if (c === "'" && !inD) inS = !inS;
            else if (c === '"' && !inS) inD = !inD;
            else if (c === '#' && !inS && !inD && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
                return line.slice(0, i);
            }
        }
        return line;
    }

    function unquote(v) {
        if (v.length >= 2) {
            if (v[0] === "'" && v[v.length - 1] === "'") {
                return v.slice(1, -1).replace(/''/g, "'");
            }
            if (v[0] === '"' && v[v.length - 1] === '"') {
                return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
        }
        return v;
    }

    function scalar(v) {
        return unquote(v.trim());
    }

    function isListLine(line) {
        return !!line && /^-(?:\s|$)/.test(line.text);
    }

    /**
     * 解析 YAML 文本为 JS 对象。
     * @param {string} text
     * @returns {Object}
     */
    function parse(text) {
        if (typeof text !== 'string') text = String(text == null ? '' : text);
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

        var raw = text.split(/\r\n|\r|\n/);
        var lines = [];
        for (var i = 0; i < raw.length; i++) {
            var s = raw[i];
            if (!s.trim()) continue;
            var noComment = stripComment(s);
            if (!noComment.trim()) continue;
            var indent = noComment.length - noComment.replace(/^\s+/, '').length;
            lines.push({ indent: indent, text: noComment.trim(), num: i + 1 });
        }
        if (!lines.length) return {};

        var pos = 0;

        function parseBlock(indent) {
            if (isListLine(lines[pos])) {
                var arr = [];
                while (pos < lines.length && lines[pos].indent === indent && isListLine(lines[pos])) {
                    var itemText = lines[pos].text.replace(/^-\s*/, '');
                    pos++;
                    if (itemText === '') {
                        // 列表项内部是嵌套块（本项目数据不会出现），容错记 null
                        if (pos < lines.length && lines[pos].indent > indent) {
                            arr.push(parseBlock(lines[pos].indent));
                        } else {
                            arr.push(null);
                        }
                    } else {
                        arr.push(scalar(itemText));
                    }
                }
                return arr;
            }

            var obj = {};
            while (pos < lines.length) {
                var ln = lines[pos];
                if (ln.indent < indent) break;
                if (ln.indent > indent) {
                    // 缩进异常（不属于任何键），跳过
                    pos++;
                    continue;
                }
                if (isListLine(ln)) break;

                var ci = ln.text.indexOf(':');
                if (ci < 0) {
                    pos++;
                    continue;
                }
                var key = scalar(ln.text.slice(0, ci));
                var rest = ln.text.slice(ci + 1).trim();
                pos++;

                if (rest === '') {
                    if (pos < lines.length && lines[pos].indent > indent) {
                        obj[key] = parseBlock(lines[pos].indent);
                    } else if (pos < lines.length && lines[pos].indent === indent && isListLine(lines[pos])) {
                        // Bukkit / SnakeYAML 风格：块列表与父键同缩进
                        obj[key] = parseBlock(indent);
                    } else {
                        obj[key] = null;
                    }
                } else if (rest[0] === '[' && rest[rest.length - 1] === ']') {
                    obj[key] = rest
                        .slice(1, -1)
                        .split(',')
                        .map(function (t) {
                            return scalar(t);
                        })
                        .filter(function (t) {
                            return t !== '';
                        });
                } else {
                    obj[key] = scalar(rest);
                }
            }
            return obj;
        }

        return parseBlock(lines[0].indent);
    }

    MMS.yaml = { parse: parse };
})(typeof window !== 'undefined' ? window : globalThis);
