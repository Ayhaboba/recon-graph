// EXTRACTED VERBATIM from /home/erema/obsidian-re/app.pretty.js
// Region: graph core (helpers, node kZ, link CZ, renderer MZ, local-graph SZ, pixi lazy loader)
// Start line: 95271 (cZ = .2)
// End line:   96084 (var xZ = yE(...))
// Lines: 814 | Do not reformat. Free identifiers -> src/DEPS.md
// EDITS for standalone load (Stage 2):
// 1. inserted `var ` before cZ (orphaned declaration list had no keyword)
// 2. replaced trailing `,` after xZ = yE(...) with `;` (closed the declaration)
// 3. appended window.__obsidianGraph export tail
// 4. no other bytes changed; TZ intentionally excluded
//
// EDITS for standalone page (Stage 3) — all line numbers are THIS file:
// 1. line  95: onNodeRightClick call wrapped in `window.__obsidianHost` guard
// 2. line 311: Worker path made relative: leading slash removed (page served from project root)
// 3. line 384: onNodeClick call wrapped in `window.__obsidianHost` guard
// 4. line 420: onNodeHover call wrapped in `window.__obsidianHost` guard
// 5. line 423: onNodeUnhover call wrapped in `window.__obsidianHost` guard
// 6. line 587: onNodeUnhover call wrapped in `window.__obsidianHost` guard
// 7. line 787: copyToClipboard method body wrapped in `window.__obsidianHost` guard
//              (skips tE/mC clipboard path; debug line is line 788)
// 8. line 843: yE pixi path made relative: leading slash removed
// 9. line 846: window.__obsidianGraph export tail kept unchanged (Stage 2)
// No menus/popovers exist in this region (they live in raw-settings.js B2).
// No other bytes changed.

            var cZ = .2,
            uZ = function(e, t, n) {
                return void 0 === n && (n = .9), e * n + t * (1 - n)
            },
            hZ = function(e, t) {
                return (uZ(e >> 16 & 255, t >> 16 & 255) << 16) + (uZ(e >> 8 & 255, t >> 8 & 255) << 8) + (0 | uZ(255 & e, 255 & t))
            },
            pZ = function(e, t) {
                return t.right < e.left || t.left > e.right || t.bottom < e.top || t.top > e.bottom
            },
            dZ = function(e, t, n) {
                return {
                    left: e - n,
                    right: e + n,
                    top: t - n,
                    bottom: t + n
                }
            },
            fZ = function(e) {
                e.style.margin = "0", e.style.padding = "0", e.style.border = "0", e.style.width = "100%", e.style.height = "100%", e.style.overflow = "hidden"
            },
            vZ = {
                showAttachments: !1,
                hideUnresolved: !1,
                showOrphans: !0,
                showTags: !1,
                localFile: null,
                localJumps: 1,
                localInterlinks: !1,
                localForelinks: !0,
                localBacklinks: !0
            };

        function gZ(e) {
            return void 0 === e && (e = ""), {
                type: e,
                links: {}
            }
        }

        function mZ(e) {
            if (!e) return gZ();
            var t = gZ(e.type);
            return e.color && (t.color = e.color), t
        }
        var yZ = {
                tag: !0
            },
            bZ = {
                fill: "color-fill",
                fillFocused: "color-fill-focused",
                fillTag: "color-fill-tag",
                fillUnresolved: "color-fill-unresolved",
                fillAttachment: "color-fill-attachment",
                arrow: "color-arrow",
                circle: "color-circle",
                line: "color-line",
                text: "color-text",
                fillHighlight: "color-fill-highlight",
                lineHighlight: "color-line-highlight"
            },
            wZ = 100,
            kZ = function() {
                function e(e, t, n) {
                    var i = this;
                    this.x = null, this.y = null, this.fx = null, this.fy = null, this.forward = {}, this.reverse = {}, this.weight = 0, this.color = null, this.rendered = !1, this.fadeAlpha = 0, this.moveText = 0, this.fontDirty = !1, this.onClick = function(e) {
                        var t = e.nativeEvent;
                        if (2 === e.button || t.instanceOf(MouseEvent) && Xy(t)) {
                            var n = i.renderer;
                            n.onNodeRightClick && (window.__obsidianHost ? n.onNodeRightClick(e.nativeEvent, i.id, i.type) : console.debug("[graph] host call skipped:", "onNodeRightClick", e.nativeEvent, i.id, i.type))
                        }
                    }, this.renderer = e, this.id = t, this.type = n
                }
                return e.prototype.initGraphics = function() {
                    var e = this;
                    if (this.rendered) return !1;
                    this.rendered = !0;
                    var t, n = this.renderer;
                    (t = this.circle = new PIXI.Graphics).eventMode = "static", t.beginFill(16777215), t.drawCircle(wZ, wZ, wZ), t.endFill(), Qy.isMobile && (t.beginFill(16777215, 1e-4), t.drawCircle(wZ, wZ, 500), t.endFill()), t.pivot.x = wZ, t.pivot.y = wZ, t.cursor = "pointer", t.zIndex = 1, t.on("pointerdown", (function(t) {
                        return n.onPointerDown(e, t)
                    })).on("pointerover", (function(t) {
                        return n.onPointerOver(e, t)
                    })).on("pointerout", (function() {
                        return n.onPointerOut()
                    })).on("click", this.onClick).on("rightclick", this.onClick);
                    var i = this.getFillColor();
                    t.alpha = i.a, t.tint = i.rgb, n.hanger.addChild(t);
                    var r = new PIXI.TextStyle(this.getTextStyle()),
                        o = this.text = new PIXI.Text(this.getDisplayText(), r);
                    return o.eventMode = "none", o.resolution = 2, o.anchor.set(.5, 0), o.zIndex = 2, n.hanger.addChild(o), this.fadeAlpha = 0, !0
                }, e.prototype.clearGraphics = function() {
                    if (this.rendered) {
                        this.rendered = !1;
                        var e = this,
                            t = e.circle,
                            n = e.highlight,
                            i = e.text;
                        t && (this.circle = null, t.parent && t.parent.removeChild(t), t.destroy()), n && (this.highlight = null, n.parent && n.parent.removeChild(n), n.destroy()), i && (this.text = null, i.parent && i.parent.removeChild(i), i.destroy())
                    }
                }, e.prototype.getTextStyle = function() {
                    var e = this.renderer,
                        t = this.getSize();
                    return new PIXI.TextStyle({
                        fontSize: 14 + t / 4,
                        fill: e.colors.text.rgb,
                        fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, "Inter", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Microsoft YaHei Light", sans-serif',
                        wordWrap: !0,
                        wordWrapWidth: 300,
                        align: "center"
                    })
                }, e.prototype.render = function() {
                    if (this.rendered) {
                        var e = this,
                            t = e.renderer,
                            n = e.x,
                            i = e.y,
                            r = e.circle,
                            o = e.highlight,
                            a = e.text,
                            s = e.fadeAlpha,
                            l = e.moveText,
                            c = this.getSize(),
                            u = this.getFillColor(),
                            h = t.colors.text,
                            p = t.getHighlightNode(),
                            d = p === this,
                            f = t.nodeScale,
                            v = a.visible,
                            g = cZ;
                        (!p || d || this.forward.hasOwnProperty(p.id) || this.reverse.hasOwnProperty(p.id)) && (g = 1);
                        var m = (s = this.fadeAlpha = uZ(s, g)) * u.a,
                            y = t.textAlpha;
                        y *= s, d && (y = 1), y *= h.a;
                        var b = d ? 15 : 0;
                        l = this.moveText = v ? uZ(l, b) : b;
                        var w = y > .001,
                            k = t.viewport,
                            C = d || !pZ(k, dZ(n, i, c * f + 1));
                        if (w && (w = d || !pZ(k, {
                                left: n - 300,
                                right: n + 300,
                                top: i,
                                bottom: i + 200
                            })), r.tint = hZ(r.tint, u.rgb), r.visible = C, C && (r.x = n, r.y = i, r.scale.x = r.scale.y = c / 100 * f, r.alpha = m), a.visible = w, w && (a.x = n, a.y = i + (c + 5) * f + l / t.scale, a.scale.x = a.scale.y = f, d && t.scale < 1 && (a.scale.x = a.scale.y = 1 / t.scale), a.alpha = y), d) {
                            o || ((o = this.highlight = new PIXI.Graphics).eventMode = "none", o.zIndex = 1, t.hanger.addChild(o)), o.x = n, o.y = i, o.scale.x = o.scale.y = f, o.clear();
                            var E = Math.max(1, 1 / t.scale / f),
                                M = t.colors.circle;
                            o.alpha = M.a, o.lineStyle(E, M.rgb, 1), o.drawCircle(0, 0, c + E / 2)
                        } else o && (o.parent.removeChild(o), o.destroy(), this.highlight = null);
                        this.fontDirty && (this.fontDirty = !1, a.style = this.getTextStyle())
                    }
                }, e.prototype.getFillColor = function() {
                    var e = this,
                        t = e.renderer,
                        n = e.type,
                        i = e.color;
                    if (t.getHighlightNode() === this) return t.colors.fillHighlight;
                    if ("focused" === n) {
                        var r = t.colors.fillFocused;
                        if (r.a > 0) return r
                    } else {
                        if (i) return i;
                        if ("tag" === n) return t.colors.fillTag;
                        if ("unresolved" === n) return t.colors.fillUnresolved;
                        if ("attachment" === n) return t.colors.fillAttachment
                    }
                    return t.colors.fill
                }, e.prototype.getSize = function() {
                    return this.renderer.fNodeSizeMult * Math.max(8, Math.min(3 * Math.sqrt(this.weight + 1), 30))
                }, e.prototype.getDisplayText = function() {
                    return Nl(this.id)
                }, e.prototype.getRelated = function() {
                    return Object.keys(this.forward).concat(Object.keys(this.reverse))
                }, e
            }(),
            CZ = function() {
                function e(e, t, n) {
                    this.rendered = !1, this.renderer = e, this.source = t, this.target = n
                }
                return e.prototype.initGraphics = function() {
                    if (!this.rendered && this.source.rendered && this.target.rendered) {
                        this.rendered = !0;
                        var e = this.renderer,
                            t = this.px = new PIXI.Container;
                        e.hanger.addChild(t);
                        var n = this.line = new PIXI.Sprite(PIXI.Texture.WHITE);
                        n.eventMode = "none";
                        var i = e.colors.line;
                        n.alpha = cZ * i.a, n.tint = i.rgb, t.addChild(n);
                        var r = this.arrow = new PIXI.Graphics;
                        r.eventMode = "none";
                        var o = e.colors.text;
                        r.alpha = cZ * o.a, r.tint = o.rgb, r.beginFill(16777215), r.moveTo(0, 0), r.lineTo(-4, -2), r.lineTo(-3, 0), r.lineTo(-4, 2), r.lineTo(0, 0), r.endFill(), r.zIndex = 1, e.hanger.addChild(r)
                    }
                }, e.prototype.clearGraphics = function() {
                    if (this.rendered) {
                        this.rendered = !1;
                        var e = this,
                            t = e.px,
                            n = e.line,
                            i = e.arrow;
                        t && (this.px = null, t.parent && t.parent.removeChild(t), t.destroy(), t.visible = !1), n && (this.line = null, n.destroy(), n.visible = !1), i && (this.arrow = null, i.parent && i.parent.removeChild(i), i.destroy(), i.visible = !1)
                    }
                }, e.prototype.render = function() {
                    if (this.rendered) {
                        var e = this,
                            t = e.px,
                            n = e.line,
                            i = e.arrow,
                            r = e.renderer,
                            o = e.source,
                            a = e.target,
                            s = r.getHighlightNode(),
                            l = o === s || a === s,
                            c = cZ;
                        s && !l || (c = 1);
                        var u = c * Math.clamp(2 * (r.scale - .3), 0, 1),
                            h = r.colors.line;
                        l && (h = r.colors.lineHighlight);
                        var p, d, f = r.colors.arrow,
                            v = !(o.reverse.hasOwnProperty(a.id) && o.id.localeCompare(a.id) < 0),
                            g = r.fShowArrow,
                            m = r.fLineSizeMult / r.scale,
                            y = r.viewport,
                            b = dZ(o.x, o.y, m),
                            w = dZ(a.x, a.y, m),
                            k = !pZ(y, (p = b, d = w, {
                                left: Math.min(p.left, d.left),
                                right: Math.max(p.right, d.right),
                                top: Math.min(p.top, d.top),
                                bottom: Math.max(p.bottom, d.bottom)
                            }));
                        if (c *= h.a, u *= f.a, n.alpha = uZ(n.alpha, c), i.alpha = uZ(i.alpha, u), v = v && k, g = g && k && i.alpha > .001, n.visible = v, i.visible = g, v || g) {
                            var C = a.x - o.x,
                                E = a.y - o.y,
                                M = Math.sqrt(C * C + E * E),
                                S = o.getSize() * r.nodeScale,
                                x = a.getSize() * r.nodeScale;
                            i.visible = g = g && M > m, v && (t.x = o.x + C * S / M, t.y = o.y + E * S / M, t.pivot.set(0, 0), t.rotation = Math.atan2(E, C), n.x = 0, n.y = -m / 2, n.width = Math.max(0, M - S - x), n.height = m, n.tint = hZ(n.tint, h.rgb)), i.visible = g, g && (x += 1, i.x = a.x - C * x / M, i.y = a.y - E * x / M, i.pivot.set(0, 0), i.rotation = Math.atan2(E, C), i.scale.x = i.scale.y = 2 * Math.sqrt(r.fLineSizeMult) / r.scale, i.tint = f.rgb)
                        }
                    }
                }, e
            }(),
            EZ = function() {
                function e(e) {
                    this.rendered = !1, this.renderer = e
                }
                return e.prototype.initGraphics = function() {
                    var e = this.renderer;
                    if (!this.text) {
                        var t = this.text = new PIXI.Text("Powered by Obsidian", this.getTextStyle());
                        t.eventMode = "none", t.anchor.set(1, 1), t.zIndex = 3, t.alpha = .5, e.px.stage.addChild(t)
                    }
                }, e.prototype.clearGraphics = function() {
                    var e = this.text;
                    e && e.parent && (this.text = null, e.parent.removeChild(e), e.destroy()), this.rendered = !1
                }, e.prototype.render = function() {
                    var e = this.renderer,
                        t = this.text;
                    if (t) {
                        t.visible = !e.hidePowerTag, t.alpha = e.colors.text.a;
                        var n = e.px.renderer;
                        t.x = n.width / n.resolution, t.y = n.height / n.resolution, this.rendered || (this.rendered = !0, this.text.style = this.getTextStyle())
                    }
                }, e.prototype.getTextStyle = function() {
                    return new PIXI.TextStyle({
                        fontSize: 12,
                        fill: this.renderer.colors.text.rgb,
                        fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, "Inter", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Microsoft YaHei Light", sans-serif',
                        wordWrap: !1,
                        align: "right"
                    })
                }, e
            }(),
            MZ = function() {
                function e(e, t, n, i) {
                    var r = this;
                    this.interactiveEl = null, this.onNodeClick = null, this.onNodeRightClick = null, this.onNodeHover = null, this.onNodeUnhover = null, this.workerResults = null, this.nodeLookup = {}, this.nodes = [], this.links = [], this.dragNode = null, this.highlightNode = null, this.px = null, this.hanger = null, this.powerTag = null, this.scale = 1, this.nodeScale = 1, this.textAlpha = 1, this.targetScale = 1, this.panX = 0, this.panY = 0, this.panvX = 0, this.panvY = 0, this.keyboardActions = {}, this.panning = !1, this.width = 0, this.height = 0, this.viewport = null, this.zoomCenterX = 0, this.zoomCenterY = 0, this.hidePowerTag = !1, this.fNodeSizeMult = 1, this.fLineSizeMult = 1, this.fTextShowMult = 1, this.fShowArrow = !1, this.mouseX = null, this.mouseY = null, this.colors = {}, this.renderTimer = null, this.hidePowerTag = n, this.containerEl = e, this.testCSS();
                    var o = this.interactiveEl = e.createEl("canvas");
                    if (e.style.padding = "0", e.style.overflow = "hidden", e.style.position = "relative", o.style.position = "absolute", o.style.left = "0", o.style.top = "0", fZ(o), o.addEventListener("mousedown", (function(e) {
                            return e.preventDefault()
                        })), o.addEventListener("wheel", this.onWheel.bind(this), {
                            passive: !1
                        }), o.addEventListener("mousemove", this.onMouseMove.bind(this), {
                            passive: !0
                        }), o.addEventListener("mouseout", this.onMouseMove.bind(this)), i || (i = new Worker("sim.js", {
                            name: "Graph Worker"
                        })), this.worker = i, i.onmessage = function(e) {
                            e.data.ignore || (r.workerResults = e.data, r.changed())
                        }, t) {
                        var a = this.iframeEl = e.createEl("iframe");
                        fZ(a), a.onload = this.onIframeLoad.bind(this), a.contentDocument && this.onIframeLoad()
                    } else {
                        var s = e.createEl("canvas");
                        fZ(s), setTimeout((function() {
                            try {
                                r.initGraphics(s)
                            } catch (e) {
                                setTimeout((function() {
                                    r.initGraphics(s)
                                }), 300)
                            }
                        }), 50)
                    }
                }
                return e.prototype.destroy = function() {
                    this.worker.terminate(), this.workerResults = null, this.destroyGraphics()
                }, e.prototype.onIframeLoad = function() {
                    var e = this.iframeEl;
                    e.contentWindow.onbeforeunload = this.onIframeUnload.bind(this);
                    var t = e.contentDocument.body;
                    fZ(t), t.innerHTML = "<canvas>";
                    var n = t.firstChild;
                    fZ(n), this.destroyGraphics(), this.initGraphics(n)
                }, e.prototype.onIframeUnload = function() {
                    this.destroyGraphics()
                }, e.prototype.onWheel = function(e) {
                    if (e.preventDefault(), this.px) {
                        var t = e.deltaY;
                        1 === e.deltaMode ? t *= 40 : 2 === e.deltaMode && (t *= 800);
                        var n = this.targetScale;
                        if (n *= Math.pow(1.5, -t / 120), this.targetScale = n, n < this.scale) this.zoomCenterX = 0, this.zoomCenterY = 0;
                        else {
                            var i = window.devicePixelRatio;
                            this.zoomCenterX = e.offsetX * i, this.zoomCenterY = e.offsetY * i
                        }
                        this.changed()
                    }
                }, e.prototype.onMouseMove = function(e) {
                    "mouseout" === e.type ? this.mouseX = this.mouseY = null : (this.mouseX = e.offsetX, this.mouseY = e.offsetY)
                }, e.prototype.initGraphics = function(e) {
                    var t, n = this,
                        i = this,
                        r = i.iframeEl,
                        o = i.interactiveEl,
                        a = i.worker;
                    PIXI.settings.RENDER_OPTIONS.hello = !1;
                    var s = window.WebGL2RenderingContext;
                    try {
                        r && r.contentWindow.WebGL2RenderingContext && (window.WebGL2RenderingContext = r.contentWindow.WebGL2RenderingContext), t = this.px = new PIXI.Application({
                            view: e,
                            antialias: !0,
                            backgroundAlpha: 0,
                            autoStart: !1
                        })
                    } finally {
                        window.WebGL2RenderingContext = s
                    }
                    t.renderer.events.setTargetElement(o);
                    var l = null;
                    this.onPointerDown = function(e, i) {
                        i.nativeEvent.target === o && (m || (n.dragNode = e, l = i.getLocalPosition(t.stage)))
                    };
                    var c = function(e) {
                        e.nativeEvent.instanceOf(TouchEvent) && k(e.nativeEvent);
                        var t = n.dragNode;
                        if (t) {
                            var i = e.nativeEvent;
                            l && n.onNodeClick && (i.instanceOf(MouseEvent) && (0 === i.button || 1 === i.button) && !Xy(i) || i.instanceOf(TouchEvent)) && (window.__obsidianHost ? n.onNodeClick(i, t.id, t.type) : console.debug("[graph] host call skipped:", "onNodeClick", i, t.id, t.type)), t.fx = null, t.fy = null, a.postMessage({
                                alphaTarget: 0,
                                forceNode: {
                                    id: t.id,
                                    x: null,
                                    y: null
                                }
                            }), l = null, n.dragNode = null, n.changed()
                        }
                    };
                    t.stage.on("pointermove", (function(e) {
                        var i = n.dragNode;
                        if (i) {
                            if (y) return l = null, void(n.dragNode = null);
                            if (l) {
                                var r = e.getLocalPosition(t.stage),
                                    o = r.x - l.x,
                                    s = r.y - l.y;
                                o * o + s * s > 25 && (l = null)
                            }
                            var c = e.getLocalPosition(n.hanger);
                            i.fx = c.x, i.fy = c.y, a.postMessage({
                                alpha: .3,
                                alphaTarget: .3,
                                run: !0,
                                forceNode: {
                                    id: i.id,
                                    x: c.x,
                                    y: c.y
                                }
                            }), n.changed()
                        }
                    })).on("pointerup", c).on("pointerupoutside", c).eventMode = "static", this.onPointerOver = function(e, t) {
                        if ("touch" !== t.pointerType) {
                            n.highlightNode = e, n.changed();
                            var i = t.nativeEvent;
                            i.instanceOf(MouseEvent) && (n.mouseX = i.offsetX, n.mouseY = i.offsetY), n.onNodeHover && (window.__obsidianHost ? n.onNodeHover(i, e.id, e.type) : console.debug("[graph] host call skipped:", "onNodeHover", i, e.id, e.type))
                        }
                    }, this.onPointerOut = function() {
                        n.highlightNode = null, n.changed(), n.onNodeUnhover && (window.__obsidianHost ? n.onNodeUnhover() : console.debug("[graph] host call skipped:", "onNodeUnhover"))
                    };
                    var u = this.hanger = new PIXI.Container;
                    u.eventMode = "static";
                    var h = this.powerTag = new EZ(this);
                    this.onResize(), this.resetPan();
                    var p = new PIXI.Graphics;
                    p.eventMode = "static", p.beginFill(0), p.drawRect(0, 0, 1e4, 1e4), p.endFill(), p.alpha = 0;
                    var d = null,
                        f = null,
                        v = performance.now(),
                        g = 0,
                        m = null,
                        y = null,
                        b = 0,
                        w = 0,
                        k = function(e) {
                            for (var t = performance.now(), i = t - v, r = Array.prototype.slice.call(e.touches), o = null, a = null, s = 0, c = r; s < c.length; s++) {
                                var u = c[s];
                                m && u.identifier === m.identifier && (o = u), y && u.identifier === y.identifier && (a = u)
                            }
                            if (a && !o && (m = y, o = a, y = null, a = null), o ? r.remove(o) : r.length > 0 && (o = r.first(), r.splice(0, 1)), a ? r.remove(a) : r.length > 0 && (a = r.first(), r.splice(0, 1)), !l && !n.dragNode && m && o && m.identifier === o.identifier) {
                                var h = window.devicePixelRatio;
                                if (y && a && y.identifier === a.identifier) {
                                    var p = n.interactiveEl.getBoundingClientRect(),
                                        d = ((m.clientX + y.clientX) / 2 - p.x) * h,
                                        f = ((m.clientY + y.clientY) / 2 - p.y) * h,
                                        k = ((o.clientX + a.clientX) / 2 - p.x) * h,
                                        C = ((o.clientY + a.clientY) / 2 - p.y) * h,
                                        E = m.clientX - y.clientX,
                                        M = m.clientY - y.clientY,
                                        S = o.clientX - a.clientX,
                                        x = o.clientY - a.clientY,
                                        T = E * E + M * M,
                                        D = S * S + x * x;
                                    if (0 !== T && 0 !== D) {
                                        var A = Math.sqrt(D / T),
                                            P = n.targetScale * A,
                                            I = n.panX + (k - d),
                                            L = n.panY + (C - f);
                                        n.zoomCenterX = k, n.zoomCenterY = C, n.setPan(I, L), n.targetScale = P, n.changed()
                                    }
                                    b = 0, w = 0
                                } else {
                                    var O = (o.clientX - m.clientX) * h,
                                        F = (o.clientY - m.clientY) * h;
                                    g = uZ(g, i, .8), v = t, b = uZ(b, O, .8), w = uZ(w, F, .8), n.setPan(n.panX + O, n.panY + F), n.changed()
                                }
                            } else g = uZ(g, i, .8), i < 100 && (n.panvX = b / g, n.panvY = w / g), b = b = 0;
                            m = o, y = a
                        },
                        C = function(e) {
                            if (e.nativeEvent.instanceOf(TouchEvent)) k(e.nativeEvent);
                            else {
                                d = null, document.body.removeClass("is-grabbing"), n.panning = !1;
                                var t = performance.now() - v;
                                g = uZ(g, t, .8), t > 100 ? n.panvX = n.panvY = 0 : (n.panvX /= g, n.panvY /= g)
                            }
                        };
                    p.on("pointerdown", (function(e) {
                        e.nativeEvent.instanceOf(TouchEvent) ? k(e.nativeEvent) : (d = e.getLocalPosition(t.stage), f = {
                            x: u.x,
                            y: u.y
                        }, document.body.addClass("is-grabbing"), n.panning = !0)
                    })), t.stage.on("pointermove", (function(e) {
                        if (e.nativeEvent.instanceOf(TouchEvent)) k(e.nativeEvent);
                        else if (d) {
                            var i = e.getLocalPosition(t.stage),
                                r = f.x + i.x - d.x,
                                o = f.y + i.y - d.y,
                                a = performance.now();
                            g = uZ(g, a - v, .8), v = a, n.panvX = uZ(n.panvX, r - n.panX, .8), n.panvY = uZ(n.panvY, o - n.panY, .8), n.setPan(r, o), n.changed()
                        }
                    })).on("pointerup", C).on("pointerupoutside", C).eventMode = "static", t.stage.addChild(p), t.stage.addChild(u), h.initGraphics(), this.updateZoom(), this.renderCallback = function() {
                        if (n.renderTimer = null, n.px && !(n.idleFrames > 60)) {
                            var e = n,
                                i = e.nodes,
                                r = e.links,
                                o = n.workerResults;
                            if (o) {
                                var a = o.id,
                                    s = o.buffer,
                                    l = !0;
                                if (s instanceof ArrayBuffer) n.workerResults = null;
                                else {
                                    var c = new Uint32Array(s, s.byteLength - 4, 1);
                                    c[0] === o.v ? l = !1 : o.v = c[0]
                                }
                                if (l)
                                    for (var p = new Float32Array(s), d = 0; d < a.length; d++) {
                                        (U = n.nodeLookup[a[d]]) && (U.x = p[2 * d], U.y = p[2 * d + 1], U.fx && (U.x = U.fx), U.fy && (U.y = U.fy))
                                    }
                            }
                            var f = n,
                                v = f.panning,
                                g = f.panvX,
                                m = f.panvY,
                                y = f.keyboardActions,
                                b = y.shift;
                            if (!v) {
                                n.panX += 1e3 * g / 60, n.panY += 1e3 * m / 60;
                                var w = 0,
                                    k = 0;
                                y.up && (k += 1), y.down && (k -= 1), y.left && (w += 1), y.right && (w -= 1), 0 === w && 0 === k || (n.idleFrames = 0);
                                var C = b ? 3 : 1;
                                n.panvX = uZ(g, w * C, .9), n.panvY = uZ(m, k * C, .9)
                            }
                            var E = 1 + (b ? .1 : .03),
                                M = !1;
                            if (y.zoomin && (n.targetScale *= E, M = !0), y.zoomout && (n.targetScale /= E, M = !0), M) {
                                n.idleFrames = 0;
                                var S = window.devicePixelRatio;
                                n.zoomCenterX = n.width / 2 * S, n.zoomCenterY = n.height / 2 * S
                            }
                            n.updateZoom();
                            var x = n.scale,
                                T = -n.panX / x,
                                D = -n.panY / x,
                                A = T + n.width / x * window.devicePixelRatio,
                                P = D + n.height / x * window.devicePixelRatio;
                            n.viewport = {
                                left: T,
                                right: A,
                                top: D,
                                bottom: P
                            };
                            for (var I = (T + A) / 2, L = (D + P) / 2, O = [], F = function(e, t) {
                                    return e.dist - t.dist
                                }, R = 0, B = i; R < B.length; R++) {
                                if (!(U = B[R]).rendered) {
                                    var N = (J = U.x - I) * J + (ee = U.y - L) * ee;
                                    (O.length < 50 || N < O.last().dist) && (O.push({
                                        node: U,
                                        dist: J * J + ee * ee
                                    }), O.sort(F), O.length > 50 && O.pop())
                                }
                            }
                            if (O.length > 0) {
                                for (var V = 0, H = O; V < H.length; V++) {
                                    H[V].node.initGraphics()
                                }
                                n.idleFrames = 0
                            }
                            for (var z = 0, q = r; z < q.length; z++) {
                                q[z].initGraphics()
                            }
                            for (var W = 0, j = i; W < j.length; W++) {
                                var U;
                                (U = j[W]).render()
                            }
                            for (var _ = 0, G = r; _ < G.length; _++) {
                                G[_].render()
                            }
                            h.render(), u.sortChildren(), t.render(), n.idleFrames++, n.queueRender();
                            var K = n,
                                Y = K.mouseX,
                                X = K.mouseY,
                                Q = K.highlightNode;
                            if (null !== Y && null !== X && Q) {
                                var $ = (Y * window.devicePixelRatio - n.panX) / x,
                                    Z = (X * window.devicePixelRatio - n.panY) / x,
                                    J = Q.x - $,
                                    ee = Q.y - Z,
                                    te = Q.getSize() * n.nodeScale + 2;
                                J * J + ee * ee > te * te && (n.highlightNode = null, n.idleFrames = 0, n.onNodeUnhover && (window.__obsidianHost ? n.onNodeUnhover() : console.debug("[graph] host call skipped:", "onNodeUnhover")))
                            }
                        }
                    }, this.queueRender()
                }, e.prototype.destroyGraphics = function() {
                    var e = this,
                        t = e.iframeEl,
                        n = e.px,
                        i = e.links,
                        r = e.nodes,
                        o = e.powerTag;
                    this.hanger = null;
                    for (var a = 0, s = i; a < s.length; a++) {
                        s[a].clearGraphics()
                    }
                    for (var l = 0, c = r; l < c.length; l++) {
                        c[l].clearGraphics()
                    }
                    o && (this.powerTag = null, o.clearGraphics()), n && (n.renderer.events.setTargetElement(null), t && document.body.contains(t) && t.contentDocument && n.destroy(!0, {
                        children: !0,
                        texture: !0,
                        baseTexture: !0
                    }), this.px = null), this.containerEl.win.cancelAnimationFrame(this.renderTimer), this.renderTimer = null, this.renderCallback = null, document.body.removeClass("is-grabbing")
                }, e.prototype.zoomTo = function(e, t) {
                    this.targetScale = e, t ? (this.zoomCenterX = t.x, this.zoomCenterY = t.y) : this.zoomCenterX = this.zoomCenterY = 0
                }, e.prototype.onResize = function() {
                    var e = this,
                        t = e.px,
                        n = e.hanger,
                        i = e.containerEl,
                        r = e.interactiveEl,
                        o = window.devicePixelRatio,
                        a = i.clientWidth,
                        s = i.clientHeight;
                    if (this.width = a, this.height = s, t) {
                        var l = Math.round(a * o),
                            c = Math.round(s * o),
                            u = t.renderer,
                            h = u.width,
                            p = u.height;
                        u.view.style.width = a + "px", u.view.style.height = s + "px", u.resize(l, c), r.width = a, r.height = s, t.renderer.events.resolutionChange(1 / o), n && this.setPan(this.panX + (l - h) / 2, this.panY + (c - p) / 2)
                    }
                    this.changed()
                }, e.prototype.resetPan = function() {
                    var e = window.devicePixelRatio;
                    this.setPan(this.width / 2 * e, this.height / 2 * e)
                }, e.prototype.setData = function(e) {
                    for (var t = this, n = t.nodes, i = t.nodeLookup, r = t.links, o = e.nodes, a = {}, s = [], l = [], c = !1, u = !1, h = 0, p = 0, d = n; p < d.length; p++) {
                        var f = d[p];
                        o.hasOwnProperty(f.id) ? (h = Math.max(h, f.x * f.x + f.y * f.y), a[f.id] = !1) : (s.push(f), c = !0)
                    }
                    var v = Math.sqrt(h),
                        g = [];
                    for (var m in o)
                        if (o.hasOwnProperty(m)) {
                            var y = o[m];
                            if (i.hasOwnProperty(m)) {
                                var b = y.color || null;
                                (f = i[m]).color !== b && (f.color = b, u = !0), f.type !== y.type && (f.type = y.type, u = !0)
                            } else {
                                (f = new kZ(this, m, y.type)).color = y.color || null, n.push(f), i[m] = f, c = !0, g.push(f)
                            }
                        } for (var m in o)
                        if (o.hasOwnProperty(m) && i.hasOwnProperty(m)) {
                            f = i[m];
                            var w = o[m].links;
                            for (var k in f.forward) f.forward.hasOwnProperty(k) && (w.hasOwnProperty(k) || (l.push(f.forward[k]), c = !0));
                            for (var k in w)
                                if (w.hasOwnProperty(k) && !f.forward.hasOwnProperty(k) && i.hasOwnProperty(k)) {
                                    var C = i[k],
                                        E = new CZ(this, f, C);
                                    r.push(E), f.forward[C.id] = E, C.reverse[f.id] = E, c = !0
                                }
                        } for (var M = function(e) {
                            e.clearGraphics(), r.remove(e), delete e.source.forward[e.target.id], delete e.target.reverse[e.source.id]
                        }, S = 0, x = l; S < x.length; S++) {
                        M(E = x[S])
                    }
                    for (var T = 0, D = s; T < D.length; T++) {
                        (f = D[T]).clearGraphics(), n.remove(f), delete i[f.id];
                        var A = f.forward,
                            P = f.reverse;
                        for (var k in A) A.hasOwnProperty(k) && M(A[k]);
                        for (var k in P) P.hasOwnProperty(k) && M(P[k])
                    }
                    var I = g.length;
                    if (I > 0)
                        for (var L = 60 * I * 60, O = Math.sqrt(L / Math.PI + v * v) - v, F = Math.sqrt(L), R = 0, B = g; R < B.length; R++) {
                            for (var N = 0, V = 0, H = 0, z = 0, q = (f = B[R]).getRelated(); z < q.length; z++) {
                                var W = q[z];
                                if (i.hasOwnProperty(W)) {
                                    var j = i[W];
                                    null !== j.x && null !== j.y && (N += j.x, V += j.y, H++)
                                }
                            }
                            if (H > 0) f.x = N / H + (Math.random() - .5) * F, f.y = V / H + (Math.random() - .5) * F;
                            else {
                                var U = 2 * Math.random() * Math.PI,
                                    _ = v + Math.sqrt(Math.random()) * O;
                                f.x = _ * Math.cos(U), f.y = _ * Math.sin(U)
                            }
                            a[f.id] = [f.x, f.y]
                        }
                    var G = e.weights;
                    for (var m in i)
                        if (i.hasOwnProperty(m)) {
                            var K = (f = i[m]).weight;
                            K = G ? G.hasOwnProperty(m) ? G[m] : 0 : f.getRelated().length, f.weight !== K && (f.weight = K, c = !0)
                        } if (c) {
                        for (var Y = [], X = 0, Q = r; X < Q.length; X++) {
                            E = Q[X];
                            Y.push([E.source.id, E.target.id])
                        }
                        this.worker.postMessage({
                            nodes: a,
                            links: Y,
                            alpha: .3,
                            run: !0
                        }), this.changed()
                    } else u && this.changed()
                }, e.prototype.setRenderOptions = function(e) {
                    var t = e.nodeSizeMultiplier,
                        n = e.lineSizeMultiplier,
                        i = e.showArrow,
                        r = e.textFadeMultiplier;
                    Number.isNumber(t) && (this.fNodeSizeMult = t), Number.isNumber(n) && (this.fLineSizeMult = n), Number.isNumber(r) && (this.fTextShowMult = r), isBoolean(i) && (this.fShowArrow = i), this.changed()
                }, e.prototype.setForces = function(e) {
                    this.worker.postMessage({
                        forces: e,
                        alpha: .3,
                        run: !0
                    })
                }, e.prototype.getHighlightNode = function() {
                    return this.dragNode || this.highlightNode
                }, e.prototype.updateZoom = function() {
                    var e = this,
                        t = e.scale,
                        n = e.targetScale,
                        i = e.panX,
                        r = e.panY;
                    if ((t > (n = this.targetScale = Math.min(8, Math.max(1 / 128, n))) ? t / n : n / t) - 1 >= .01) {
                        var o = this.zoomCenterX,
                            a = this.zoomCenterY;
                        if (0 === o && 0 === a) {
                            var s = window.devicePixelRatio;
                            o = this.width / 2 * s, a = this.height / 2 * s
                        }
                        var l = {
                            x: (o - i) / t,
                            y: (a - r) / t
                        };
                        t = uZ(t, n, .85), i -= l.x * t + i - o, r -= l.y * t + r - a, this.changed()
                    }
                    this.setPan(i, r), this.setScale(t)
                }, e.prototype.setPan = function(e, t) {
                    var n = this.hanger;
                    this.panX = e, this.panY = t, n && (n.x = e, n.y = t)
                }, e.prototype.setScale = function(e) {
                    var t = this.hanger;
                    this.scale = e, this.nodeScale = Math.sqrt(1 / e);
                    var n = Math.log(e) / Math.log(2);
                    this.textAlpha = Math.clamp(n + 1 - this.fTextShowMult, 0, 1), t && (t.scale.x = t.scale.y = e)
                }, e.prototype.changed = function() {
                    this.idleFrames = 0, this.queueRender()
                }, e.prototype.queueRender = function() {
                    !this.renderTimer && this.renderCallback && (this.renderTimer = this.containerEl.win.requestAnimationFrame(this.renderCallback))
                }, e.prototype.testCSS = function() {
                    var e = function(e) {
                        var t = document.body.createDiv({
                                cls: "graph-view " + e
                            }),
                            n = getComputedStyle(t),
                            i = n.color,
                            r = n.opacity;
                        t.detach();
                        var o = nT(i),
                            a = parseFloat(r);
                        return isNaN(a) && (a = 1), o ? {
                            a: a * o.a,
                            rgb: o.r << 16 | o.g << 8 | o.b
                        } : {
                            a,
                            rgb: 8947848
                        }
                    };
                    for (var t in bZ) bZ.hasOwnProperty(t) && (this.colors[t] = e(bZ[t]));
                    for (var n = 0, i = this.nodes; n < i.length; n++) {
                        i[n].fontDirty = !0
                    }
                    var r = this.powerTag;
                    r && (r.rendered = !1), this.changed()
                }, e.prototype.getTransparentScreenshot = function() {
                    var e = this.px;
                    return e.render(), e.view
                }, e.prototype.getBackgroundScreenshot = function() {
                    var e = this.getTransparentScreenshot(),
                        t = document.createElement("canvas");
                    t.width = e.width, t.height = e.height;
                    var n = t.getContext("2d");
                    return n.fillStyle = "#FFFFFF", n.fillRect(0, 0, e.width, e.height), n.drawImage(e, 0, 0), t
                }, e.copyToClipboard = function(e, t) {
                    if (!window.__obsidianHost) {
                        console.debug("[graph] host call skipped:", "copyToClipboard", e, t);
                        return;
                    }
                    return y(this, void 0, void 0, (function() {
                        return b(this, (function(n) {
                            switch (n.label) {
                                case 0:
                                    return [4, tE(e, t)];
                                case 1:
                                    return [4, mC(n.sent())];
                                case 2:
                                    return n.sent(), [2]
                            }
                        }))
                    }))
                }, e
            }();

        function SZ(e, t) {
            var n = e.nodes,
                i = {},
                r = {},
                o = t.localFile,
                a = t.localJumps,
                s = t.localInterlinks,
                l = t.localForelinks,
                c = t.localBacklinks;
            if (r[o] = 30, !n.hasOwnProperty(o)) return i[o] = gZ(), {
                nodes: i,
                weights: r
            };
            i[o] = gZ(n[o].type);
            for (var u = function(e) {
                    var t = {};
                    for (var o in n)
                        if (n.hasOwnProperty(o)) {
                            var a = n[o];
                            if ("tag" !== a.type) {
                                var s = a.links;
                                for (var u in s)
                                    if (s.hasOwnProperty(u)) {
                                        var h = i[o];
                                        l && i.hasOwnProperty(o) && !i.hasOwnProperty(u) && !yZ.hasOwnProperty(h.type) ? (t[u] = t[u] || mZ(n[u]), h.links[u] = !0) : c && i.hasOwnProperty(u) && !i.hasOwnProperty(o) && !yZ.hasOwnProperty(i[u].type) && (t[o] = t[o] || mZ(n[o]), t[o].links[u] = !0)
                                    }
                            }
                        } for (var p in t) t.hasOwnProperty(p) && (i[p] = t[p], r[p] = e)
                }, h = 30 / a, p = 0; p < a; p++) u(30 - h * (p + 1));
            if (s)
                for (var d in i) i.hasOwnProperty(d) && n.hasOwnProperty(d) && (i[d] = n[d]);
            return {
                nodes: i,
                weights: r
            }
        }
        var xZ = yE("lib/pixi.min.js?7.2.4");

// --- export tail (Stage 2 addition) ---
window.__obsidianGraph = { Node: kZ, Link: CZ, Renderer: MZ, buildLocalGraph: SZ, colors: bZ, filterDefaults: vZ, nodeRadius: wZ };

// --- Stage 8 addition: search emphasis (spec §6.2) — append-only engine edit ---
// No existing byte above this line is modified. Emphasis is implemented by
// wrapping Node.prototype.render: the original renderer runs first, then the
// wrapper overrides the resulting circle tint/alpha for matching nodes and
// dims circle + text alpha for non-matching nodes.
(function () {
    var graph = window.__obsidianGraph;
    var Node = graph.Node;
    var originalRender = Node.prototype.render;

    Node.prototype.render = function () {
        var result = originalRender.apply(this, arguments);
        var renderer = this.renderer;
        var emphasis = renderer && renderer._emphasisIds;
        if (!emphasis || !this.rendered) return result;

        if (emphasis[this.id]) {
            var fill = renderer.colors.fillHighlight;
            if (this.circle) {
                this.circle.tint = fill.rgb;
                this.circle.alpha = fill.a;
            }
        } else {
            if (this.circle) this.circle.alpha *= 0.25;
            if (this.text) this.text.alpha *= 0.25;
        }
        return result;
    };

    graph.Renderer.prototype.setEmphasis = function (ids) {
        var list;
        if (ids == null) list = [];
        else if (Array.isArray(ids)) list = ids;
        else if (typeof ids[Symbol.iterator] === "function") list = Array.from(ids);
        else list = [ids];
        var map = {}, count = 0;
        for (var i = 0; i < list.length; i++) {
            var id = list[i];
            if (id !== undefined && id !== null && !map[id]) {
                map[id] = true;
                count++;
            }
        }
        if (!count) {
            this.clearEmphasis();
            return;
        }
        this._emphasisIds = map; // string-keyed set; engine ids are dataset key strings
        this.queueRender();
    };

    graph.Renderer.prototype.clearEmphasis = function () {
        this._emphasisIds = null;
        this.queueRender();
    };
})();
