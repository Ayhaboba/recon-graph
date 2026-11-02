/*
 * shims.js — host shims so Obsidian's extracted graph code runs standalone.
 * Plain ES5 classic script. No modules. Load AFTER lib/pixi.min.js and BEFORE
 * src/raw-view.js.
 *
 * ---------------------------------------------------------------------------
 * SHIM TABLE
 * ---------------------------------------------------------------------------
 * VERBATIM — logic copied from /home/erema/obsidian-re/app/enhance.js
 *   Object.isEmpty / Object.each
 *   Array.prototype.first / last / contains / remove / shuffle / unique
 *   Math.clamp
 *   Number.isNumber
 *   window.isBoolean
 *   String.isString / String.prototype.contains / startsWith / endsWith / format
 *   Node.prototype.createEl / createDiv / createSpan
 *   window.createEl / createDiv / createSpan
 *   Element.prototype.addClass / removeClass / toggleClass
 *   Node.prototype.detach / empty / instanceOf
 *   Node.prototype.doc / win getters
 *   UIEvent.prototype.instanceOf
 *   window.activeWindow / activeDocument
 *   Support copied with the above (needed by createEl/setText):
 *   Object.hasOwn fallback, Element.prototype.getText / setText / setAttr /
 *   setAttrs / getAttr, Element.prototype.addClasses / removeClasses,
 *   Node.prototype.constructorWin, window.createDiv / createSpan
 *
 * PORTED — logic copied from /home/erema/obsidian-re/app.pretty.js
 *   nT color parse (53241) + Zx (53219), Gx (53146), Yx (53160), Kx (53151),
 *     Wx (53139), Ux (53143), jx (53141), _x (53142), qx/OffscreenCanvas (53263)
 *   Nl display text (23319) + Tl (23269) + Ll (23298) + Pl (23287)
 *   Lx attachment test (53040) + Ix (53036) + extension lists (53025-53034)
 *   _m tag extractor (34160) + bm (33801) + mm (33783) + gm (33775) + vm (33773)
 *   Qy platform flags (34954) + Xy (34951) + Wy (34935) + Uy/_y/Gy/Ky/jy (34944-34948)
 *
 * STUB — guarded, never throws; unreachable in the render/interaction path
 *   yE lazy script loader (38194) — resolves immediately, PIXI is preloaded
 *   y / b tslib __awaiter/__generator — copyToClipboard only
 *   tE canvas.toBlob (38011) / mC clipboard write (37449) — copyToClipboard only
 *
 * NOT SHIMMED HERE — defined inside src/raw-view.js:
 *   uZ (raw-view.js:8), pZ (14), fZ (25), gZ (40), mZ (47), yZ/bZ (52-67), wZ (68)
 */

/* ------------------------------------------------------------------------- */
/* small definition helpers                                                   */
/* ------------------------------------------------------------------------- */

if (!Object.hasOwn) {
    Object.defineProperty(Object, "hasOwn", {
        value: function (obj, prop) {
            return Object.prototype.hasOwnProperty.call(obj, prop);
        },
        enumerable: false,
        configurable: true,
        writable: true
    });
}

var hasOwnProp = Object.hasOwn;

function defineValue(obj, name, value) {
    if (!obj[name]) {
        Object.defineProperty(obj, name, {
            value: value,
            enumerable: false,
            configurable: true,
            writable: true
        });
    }
}

function defineGetter(obj, name, getter) {
    Object.defineProperty(obj, name, {
        get: getter,
        enumerable: false,
        configurable: true
    });
}

/* ------------------------------------------------------------------------- */
/* VERBATIM — enhance.js                                                      */
/* ------------------------------------------------------------------------- */

if (!Object.isEmpty) {
    defineValue(Object, "isEmpty", function (e) {
        for (var n in e) {
            if (hasOwnProp(e, n)) return false;
        }
        return true;
    });
}

if (!Object.each) {
    Object.each = function (e, n, r) {
        for (var o in e) {
            if (hasOwnProp(e, o) && false === n.call(r, e[o], o)) return false;
        }
        return true;
    };
}

defineValue(Array.prototype, "first", function () {
    if (0 !== this.length) return this[0];
});

defineValue(Array.prototype, "last", function () {
    if (0 !== this.length) return this[this.length - 1];
});

defineValue(Array.prototype, "contains", Array.prototype.includes || function (t) {
    return -1 !== this.indexOf(t);
});

defineValue(Array.prototype, "remove", function (t) {
    for (var e = this.length - 1; e >= 0; e--) {
        this[e] === t && this.splice(e, 1);
    }
});

defineValue(Array.prototype, "shuffle", function () {
    for (var t, e, n = this.length; 0 !== n;) {
        e = Math.floor(Math.random() * n);
        t = this[n -= 1];
        this[n] = this[e];
        this[e] = t;
    }
    return this;
});

defineValue(Array.prototype, "unique", function () {
    return Array.from(new Set(this).values());
});

defineValue(Math, "clamp", function (t, e, n) {
    return Math.min(Math.max(t, e), n);
});

defineValue(Number, "isNumber", function (t) {
    return "number" == typeof t;
});

if (!window.isBoolean) {
    window.isBoolean = function (t) {
        return "boolean" == typeof t;
    };
}

defineValue(String, "isString", function (t) {
    return "string" == typeof t || t instanceof String;
});

defineValue(String.prototype, "contains", String.prototype.includes || function (t) {
    return -1 !== this.indexOf(t);
});

defineValue(String.prototype, "startsWith", function (t, e) {
    return this.substr(!e || e < 0 ? 0 : +e, t.length) === t;
});

defineValue(String.prototype, "endsWith", function (t, e) {
    var n = void 0 === e || e > this.length ? this.length : e;
    return this.substring(n - t.length, n) === t;
});

defineValue(String.prototype, "format", function () {
    for (var t = [], e = 0; e < arguments.length; e++) t[e] = arguments[e];
    return this.replace(/{(\d+)}/g, function (e, n) {
        return void 0 !== t[n] ? t[n] : e;
    });
});

/* getText / setText helpers (enhance.js) — createEl calls setText. */

function getTextContent(t) {
    var e = t.nodeType;
    if (1 === e || 9 === e || 11 === e) {
        if ("string" == typeof t.textContent) return t.textContent;
        for (var n = [], r = t.firstChild; r; r = r.nextSibling) n.push(getTextContent(r));
        return n.join("");
    }
    return (3 === e || 4 === e) && t.nodeValue || "";
}

Element.prototype.getText = function () {
    return getTextContent(this);
};

Element.prototype.setText = function (t) {
    (function (t, e) {
        if (e instanceof DocumentFragment || e instanceof Node) {
            t.empty();
            t.appendChild(e);
            return;
        }
        String.isString(e) || (e = String(e));
        var n = t.nodeType;
        1 !== n && 9 !== n && 11 !== n || (t.textContent = e);
    })(this, t);
};

Element.prototype.setAttr = function (t, e) {
    null === e ? this.removeAttribute(t) : this.setAttribute(t, String(e));
};

Element.prototype.setAttrs = function (t) {
    for (var e in t) {
        if (t.hasOwnProperty(e)) {
            var n = t[e];
            this.setAttr(e, n);
        }
    }
};

Element.prototype.getAttr = Element.prototype.getAttribute;

Element.prototype.addClass = function () {
    for (var t = [], e = 0; e < arguments.length; e++) t[e] = arguments[e];
    this.addClasses(t);
};

Element.prototype.addClasses = function (t) {
    if (t) for (var e = 0; e < t.length; e++) this.classList.add(t[e]);
};

Element.prototype.removeClass = function () {
    for (var t = [], e = 0; e < arguments.length; e++) t[e] = arguments[e];
    this.removeClasses(t);
};

Element.prototype.removeClasses = function (t) {
    for (var e = 0; e < t.length; e++) this.classList.remove(t[e]);
};

Element.prototype.toggleClass = function (t, e) {
    t instanceof Array || (t = [t]);
    e ? this.addClasses(t) : this.removeClasses(t);
};

Node.prototype.detach = function () {
    this.parentNode && this.parentNode.removeChild(this);
};

Node.prototype.empty = function () {
    for (; this.lastChild;) this.removeChild(this.lastChild);
};

Node.prototype.constructorWin = window;

Node.prototype.instanceOf = function (t) {
    if (this instanceof t) return true;
    var e = this.win[t.name];
    return !!(e && this instanceof e) || !!((e = this.constructorWin[t.name]) && this instanceof e);
};

defineGetter(Node.prototype, "doc", function () {
    return this.ownerDocument || document;
});

defineGetter(Node.prototype, "win", function () {
    return this.doc.defaultView || window;
});

UIEvent.prototype.instanceOf = function (t) {
    if (this instanceof t) return true;
    var e = this.view;
    if (!e) return false;
    var n = e[t.name];
    return !(!n || n === t) && this instanceof n;
};

/* createEl / createDiv / createSpan (enhance.js) */

var createEl = function (t, e, n) {
    var r = document.createElement(t);
    "string" == typeof e && (e = { cls: e });
    var o = e || {},
        i = o.cls,
        s = o.text,
        a = o.attr,
        c = o.title,
        u = o.value,
        p = o.placeholder,
        l = o.type,
        f = o.parent,
        d = o.prepend,
        h = o.href;
    for (var y in (i && (Array.isArray(i) ? r.className = i.join(" ") : r.className = i),
            s && r.setText(s),
            a && r.setAttrs(a),
            void 0 !== c && (r.title = c),
            void 0 !== u && (r instanceof HTMLInputElement || r instanceof HTMLSelectElement || r instanceof HTMLOptionElement) && (r.value = u),
            l && r instanceof HTMLInputElement && (r.type = l),
            l && r instanceof HTMLStyleElement && r.setAttribute("type", l),
            p && r instanceof HTMLInputElement && (r.placeholder = p),
            h && (r instanceof HTMLAnchorElement || r instanceof HTMLLinkElement || r instanceof HTMLBaseElement) && (r.href = h),
            n && n(r),
            f && (d ? f.insertBefore(r, f.firstChild) : f.appendChild(r)),
            e))
        if (e.hasOwnProperty(y) && y.startsWith("on")) {
            var m = y,
                v = e[m];
            "function" == typeof v && r.addEventListener(m.substring(2), v);
        }
    return r;
};

window.createEl = createEl;
window.createDiv = function (t, e) {
    return createEl("div", t, e);
};
window.createSpan = function (t, e) {
    return createEl("span", t, e);
};

Node.prototype.createEl = function (t, e, n) {
    "string" == typeof e && (e = { cls: e });
    (e = e || {}).parent = this;
    return createEl(t, e, n);
};

Node.prototype.createDiv = function (t, e) {
    return this.createEl("div", t, e);
};

Node.prototype.createSpan = function (t, e) {
    return this.createEl("span", t, e);
};

window.activeWindow = window;
window.activeDocument = document;

if (typeof globalThis !== "undefined") {
    globalThis.activeWindow = window;
    globalThis.activeDocument = document;
}

/* ------------------------------------------------------------------------- */
/* PORTED — app.pretty.js: colors (nT family)                                 */
/* ------------------------------------------------------------------------- */

var qx,
    Wx = function (e) {
        return 255 & parseInt(e);
    },
    jx = /^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(,\s*[\d.]+\s*)?\)$/i,
    Ux = /^hsla?\s*\(\s*([\d.]+)(deg|rad|grad|turn)?\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(,\s*[\d.]+\s*)?\)$/i,
    _x = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})?$/i;

function Gx(e) {
    var t = e.match(jx);
    return t ? {
        r: Wx(t[1]),
        g: Wx(t[2]),
        b: Wx(t[3]),
        a: t[4] ? Math.clamp(parseFloat(t[4].substring(1)), 0, 1) : 1
    } : null;
}

function Kx(e, t, n) {
    return n < 0 && (n += 1), n > 1 && (n -= 1), n < 1 / 6 ? e + 6 * (t - e) * n : n < .5 ? t : n < 2 / 3 ? e + (t - e) * (2 / 3 - n) * 6 : e;
}

function Yx(e) {
    var t, n, i, r = e.h,
        o = e.s,
        a = e.l;
    if (r /= 360, a /= 100, 0 == (o /= 100)) t = n = i = a;
    else {
        var s = a < .5 ? a * (1 + o) : a + o - a * o,
            l = 2 * a - s;
        t = Kx(l, s, r + 1 / 3), n = Kx(l, s, r), i = Kx(l, s, r - 1 / 3);
    }
    return {
        r: Math.round(255 * t),
        g: Math.round(255 * n),
        b: Math.round(255 * i)
    };
}

function Zx(e) {
    var t = _x.exec(e);
    return t ? {
        r: parseInt(t[1], 16),
        g: parseInt(t[2], 16),
        b: parseInt(t[3], 16),
        a: t[4] ? parseInt(t[4], 16) / 255 : 1
    } : null;
}

var tT = Object.create(null);

function nT(e) {
    var t = Zx(e) || Gx(e);
    if (t) return t;
    var n = function (e) {
        var t = e.match(Ux);
        if (t) {
            var n = t[1],
                i = t[2],
                r = parseFloat(n);
            return "rad" === i ? r = 180 * r / Math.PI : "grad" === i ? r *= .9 : "turn" === i && (r *= 360), {
                h: r,
                s: Wx(t[3]),
                l: Wx(t[4]),
                a: t[5] ? Math.clamp(parseFloat(t[5].substring(1)), 0, 1) : 1
            };
        }
        return null;
    }(e);
    if (n) return Object.assign({}, Yx(n), {
        a: n.a
    });
    if (Object.hasOwn(tT, e)) return tT[e];
    void 0 === qx && (qx = "undefined" != typeof OffscreenCanvas ? new OffscreenCanvas(1, 1).getContext("2d", {
        willReadFrequently: !0
    }) : null);
    var i = null;
    if (qx) try {
        var r = "#010203";
        if (qx.fillStyle = r, qx.fillStyle = e, qx.fillStyle !== r) {
            qx.clearRect(0, 0, 1, 1), qx.fillRect(0, 0, 1, 1);
            var o = qx.getImageData(0, 0, 1, 1).data;
            i = {
                r: o[0],
                g: o[1],
                b: o[2],
                a: o[3] / 255
            };
        }
    } catch (e) {}
    return tT[e] = i, i;
}

/* ------------------------------------------------------------------------- */
/* PORTED — app.pretty.js: display name / attachment / tags                   */
/* ------------------------------------------------------------------------- */

function Tl(e) {
    var t = e.lastIndexOf("/");
    return -1 === t ? e : e.slice(t + 1);
}

function Ll(e) {
    var t = e.lastIndexOf(".");
    return -1 === t || t === e.length - 1 || 0 === t ? "" : e.substr(t + 1).toLowerCase();
}

function Pl(e) {
    var t = Tl(e),
        n = t.lastIndexOf(".");
    return -1 === n || n === t.length - 1 || 0 === n ? t : t.substr(0, n);
}

function Nl(e) {
    var t = Tl(e);
    return "md" === Ll(t) ? Pl(t) : t;
}

var kx = ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"],
    Cx = ["mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus"],
    Ex = ["mp4", "webm", "ogv", "mov", "mkv"],
    Mx = ["pdf"],
    Sx = ["md"],
    xx = ["canvas"],
    Tx = ["base"],
    Ax = Sx.concat(xx, Tx);

function Ix(e) {
    return !Ax.includes(e);
}

function Lx(e) {
    return Ix(Ll(e));
}

var vm = Object.prototype.hasOwnProperty;

function gm(e, t) {
    if (!e) return null;
    if ("string" == typeof t) return vm.call(e, t) ? e[t] : null;
    for (var n in e) {
        if (vm.call(e, n) && t.test(n)) return e[n];
    }
    return null;
}

function mm(e, t) {
    var n = gm(e, t);
    return n ? "string" == typeof n ? [n.trim()] : Array.isArray(n) ? n.filter(function (e) {
        return "string" == typeof e;
    }).map(function (e) {
        return e.trim();
    }) : null : null;
}

function bm(e) {
    if (!e) return null;
    var t = mm(e, /^tags$/i);
    if (t) {
        t = t.filter(function (e) {
            return !!e && !e.includes(" ");
        });
        for (var n = 0; n < t.length; n++) {
            var i = t[n];
            "#" !== i.charAt(0) && (t[n] = "#" + i);
        }
    }
    return t;
}

function _m(e) {
    if (!e) return null;
    var t = [],
        n = bm(e.frontmatter);
    if (n) {
        for (var i = 0, r = n; i < r.length; i++) {
            var o = r[i];
            t.push(o);
        }
    }
    var a = e.tags;
    if (a) {
        for (var s = 0, l = a; s < l.length; s++) {
            o = l[s];
            t.push(o.tag);
        }
    }
    return t;
}

/* ------------------------------------------------------------------------- */
/* PORTED — app.pretty.js: platform flags                                     */
/* ------------------------------------------------------------------------- */

var Wy = function () {
        var e = "undefined" != typeof process ? process.platform : "";
        if ("win32" === e) return "win";
        if ("darwin" === e) return "mac";
        if ("linux" === e) return "linux";
        if (e) return "unknown";
        var t = navigator.userAgent;
        return -1 !== t.indexOf("Win") ? "win" : -1 !== t.indexOf("Mac") ? "mac" : -1 !== t.indexOf("X11") || -1 !== t.indexOf("Linux") ? "linux" : "unknown";
    }(),
    jy = navigator.userAgent.toLowerCase(),
    Uy = "mac" === Wy,
    _y = "win" === Wy,
    Gy = "linux" === Wy,
    Ky = /^((?!chrome|android).)*safari/i.test(jy);

function Xy(e) {
    return Uy && 0 === e.button && e.ctrlKey;
}

var Qy = {
    isDesktop: !1,
    isMobile: !1,
    isDesktopApp: !1,
    isMobileApp: !1,
    isIosApp: !1,
    isAndroidApp: !1,
    isPhone: !1,
    isTablet: !1,
    isMacOS: Uy,
    isWin: _y,
    isLinux: Gy,
    isSafari: Ky,
    resourcePathPrefix: "file:///",
    get canExportPdf() {
        return Qy.isDesktopApp;
    },
    get canPopoutWindow() {
        return Qy.isDesktopApp && Qy.isDesktop;
    },
    get canStackTabs() {
        return !Qy.isPhone;
    },
    get canSplit() {
        return !Qy.isPhone;
    },
    get canDisplayRibbon() {
        return !Qy.isPhone;
    },
    get canPinSidebar() {
        return Qy.isMobile && !Qy.isPhone;
    },
    get canOpenExternalFiles() {
        return Qy.isDesktopApp && Qy.isDesktop;
    },
    supportsIndexedDb: !!window.indexedDB,
    mobileSoftKeyboardVisible: !1,
    hasPhysicalKeyboard: !1,
    version: "",
    build: "",
    manufacturer: "",
    model: "",
    osName: "",
    osVersion: "",
    deviceName: ""
};

/* ------------------------------------------------------------------------- */
/* STUBS — guarded, no throw; unreachable in render/interaction path          */
/* ------------------------------------------------------------------------- */

/* STUB — yE (app.pretty.js:38194). PIXI is preloaded, so resolve immediately. */
window.yE = function () {
    return {
        loaded: true,
        get promise() {
            return Promise.resolve();
        },
        then: function (fn) {
            try {
                fn && fn();
            } catch (e) {
                console.error("[shims] yE stub callback failed", e);
            }
            return this;
        }
    };
};

/* STUB — tslib __awaiter (y) / __generator (b). Only copyToClipboard uses them. */
function y() {
    return Promise.resolve();
}

function b() {
    return {
        next: function () {
            return {
                done: true,
                value: void 0
            };
        },
        throw: function (e) {
            throw e;
        },
        return: function (e) {
            return {
                done: true,
                value: e
            };
        }
    };
}

/* STUB — tE (38011) canvas.toBlob helper; mC (37449) clipboard write. */
function tE(e, t, n) {
    return Promise.resolve(null);
}

function mC(e) {
    return Promise.resolve();
}

/* ------------------------------------------------------------------------- */
/* explicit global exports for raw-view.js free identifiers                   */
/* ------------------------------------------------------------------------- */

window.Tl = Tl;
window.Ll = Ll;
window.Pl = Pl;
window.Nl = Nl;
window.Ix = Ix;
window.Lx = Lx;
window.gm = gm;
window.mm = mm;
window.bm = bm;
window._m = _m;
window.Wx = Wx;
window.Gx = Gx;
window.Kx = Kx;
window.Yx = Yx;
window.Zx = Zx;
window.nT = nT;
window.Wy = Wy;
window.Uy = Uy;
window._y = _y;
window.Gy = Gy;
window.Ky = Ky;
window.jy = jy;
window.Xy = Xy;
window.Qy = Qy;
window.y = y;
window.b = b;
window.tE = tE;
window.mC = mC;
