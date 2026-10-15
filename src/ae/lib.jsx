// ae-mcp shared ExtendScript library.
// Prepended (via string concatenation, not #include) to every generated script
// before it runs inside After Effects via osascript/DoScriptFile.

// --- JSON polyfill -----------------------------------------------------
// After Effects 2026 does provide a native JSON object, but its
// JSON.stringify is broken for common ASCII characters (empirically:
// "-", "/", "+" all throw "Object of type Function found where a Number,
// Array, or Property is needed") -- meaning virtually any real file path
// or error message breaks it. So stringify/parse are always replaced with
// our own implementation below, not just installed when missing.
// Deliberately avoids any backslash-escape sequences in this source file
// (building them at runtime via String.fromCharCode instead) since those
// proved fragile to round-trip through some file-writing pipelines.
if (typeof JSON !== "object") {
    JSON = {};
}
(function () {
    var BACKSLASH = String.fromCharCode(92);
    var QUOTE = String.fromCharCode(34);

    function hex4(code) {
        var h = code.toString(16);
        while (h.length < 4) { h = "0" + h; }
        return BACKSLASH + "u" + h;
    }

    var ESCAPES = {};
    ESCAPES[String.fromCharCode(8)] = BACKSLASH + "b";
    ESCAPES[String.fromCharCode(9)] = BACKSLASH + "t";
    ESCAPES[String.fromCharCode(10)] = BACKSLASH + "n";
    ESCAPES[String.fromCharCode(12)] = BACKSLASH + "f";
    ESCAPES[String.fromCharCode(13)] = BACKSLASH + "r";
    ESCAPES[QUOTE] = BACKSLASH + QUOTE;
    ESCAPES[BACKSLASH] = BACKSLASH + BACKSLASH;

    function quoteString(s) {
        // Deliberately uses hasOwnProperty rather than "ESCAPES[ch] !== undefined"
        // to detect a miss: empirically, ExtendScript's engine exposes native
        // operator-named functions (e.g. bracket-accessing a plain object with
        // "-", "/", or "+") through the prototype chain, so a miss on those
        // specific keys does NOT come back as undefined -- it comes back as a
        // callable native function, which then gets string-concatenated in
        // place of the real character, corrupting the output.
        var out = QUOTE, i, ch, code;
        for (i = 0; i < s.length; i += 1) {
            ch = s.charAt(i);
            if (Object.prototype.hasOwnProperty.call(ESCAPES, ch)) {
                out += ESCAPES[ch];
            } else {
                code = s.charCodeAt(i);
                out += (code < 0x20) ? hex4(code) : ch;
            }
        }
        return out + QUOTE;
    }

    function stringifyValue(value) {
        var i, partial, k, v, t = typeof value;

        if (value === null || value === undefined) { return "null"; }
        if (t === "string") { return quoteString(value); }
        if (t === "number") { return isFinite(value) ? String(value) : "null"; }
        if (t === "boolean") { return String(value); }
        if (t === "object") {
            if (typeof value.toJSON === "function") {
                return stringifyValue(value.toJSON());
            }
            if (Object.prototype.toString.call(value) === "[object Array]") {
                partial = [];
                for (i = 0; i < value.length; i += 1) {
                    partial.push(stringifyValue(value[i]));
                }
                return "[" + partial.join(",") + "]";
            }
            partial = [];
            for (k in value) {
                if (Object.prototype.hasOwnProperty.call(value, k)) {
                    v = value[k];
                    if (v === undefined || typeof v === "function") { continue; }
                    partial.push(quoteString(k) + ":" + stringifyValue(v));
                }
            }
            return "{" + partial.join(",") + "}";
        }
        return "null";
    }

    // Always install our own stringify/parse, even if AE already provides a
    // native JSON object: empirically, AE 2026's native JSON.stringify throws
    // ("Object of type Function found where a Number, Array, or Property is
    // needed") on strings containing plain ASCII characters like "-", "/", or
    // "+" -- which appear in virtually any real file path or error message.
    // Guarding on "already has JSON" (as a strict ES3-only-when-missing
    // polyfill normally would) silently leaves that broken native version in
    // place, so we unconditionally override it instead.
    JSON.stringify = function (value) {
        return stringifyValue(value);
    };

    JSON.parse = function (text) {
        return eval("(" + String(text) + ")");
    };
}());

// --- AE object-model helpers --------------------------------------------

var __PROPERTY_PATH_SHORTCUTS = {
    "Transform": "ADBE Transform Group",
    "Effects": "ADBE Effect Parade",
    "Text": "ADBE Text Properties",
    "Masks": "ADBE Mask Parade",
    "Layer Styles": "ADBE Layer Styles"
};

function __resolveComp(compId, compName) {
    var i, it;
    for (i = 1; i <= app.project.numItems; i += 1) {
        it = app.project.item(i);
        if (!(it instanceof CompItem)) continue;
        if (compId !== null && compId !== undefined && it.id === compId) return it;
        if (compName !== null && compName !== undefined && it.name === compName) return it;
    }
    if ((compId === null || compId === undefined) && (compName === null || compName === undefined)) {
        if (app.project.activeItem instanceof CompItem) return app.project.activeItem;
    }
    throw new Error("Composition not found (id=" + compId + ", name=" + compName + ")");
}

function __resolveLayer(comp, layerIndex, layerName) {
    var i;
    if (layerIndex !== null && layerIndex !== undefined) {
        if (layerIndex < 1 || layerIndex > comp.numLayers) {
            throw new Error("Layer index " + layerIndex + " out of range (comp has " + comp.numLayers + " layers)");
        }
        return comp.layer(layerIndex);
    }
    if (layerName !== null && layerName !== undefined) {
        for (i = 1; i <= comp.numLayers; i += 1) {
            if (comp.layer(i).name === layerName) return comp.layer(i);
        }
    }
    throw new Error("Layer not found (index=" + layerIndex + ", name=" + layerName + ")");
}

function __resolvePropertyPath(layer, pathStr) {
    var parts = pathStr.split("."), i, seg, lookupKey, current = layer, next;
    for (i = 0; i < parts.length; i += 1) {
        seg = parts[i];
        lookupKey = (i === 0 && __PROPERTY_PATH_SHORTCUTS[seg]) ? __PROPERTY_PATH_SHORTCUTS[seg] : seg;
        next = null;
        try {
            next = current.property(lookupKey);
        } catch (e) {
            next = null;
        }
        if (next === null || next === undefined) {
            throw new Error("Property path segment '" + seg + "' not found in path '" + pathStr +
                "' (searched under " + (current.name || current.matchName) + ")");
        }
        current = next;
    }
    return current;
}

// Detects whether a property holds an AE Shape value (mask paths, some
// shape-layer path properties) so callers can special-case (de)serialization.
function __isShapeProperty(prop) {
    try {
        return prop.propertyValueType === PropertyValueType.SHAPE;
    } catch (e) {
        return false;
    }
}

function __isTextDocumentProperty(prop) {
    try {
        return prop.propertyValueType === PropertyValueType.TEXT_DOCUMENT;
    } catch (e) {
        return false;
    }
}

// value: { vertices: [[x,y],...], inTangents?: [[x,y],...], outTangents?: [[x,y],...], closed?: boolean }
function __zeroTangents(vertices) {
    // Array.prototype.map is ES5 and unavailable in ExtendScript's ES3 engine.
    var out = [], i;
    for (i = 0; i < vertices.length; i += 1) {
        out.push([0, 0]);
    }
    return out;
}

function __shapeFromPlainObject(value) {
    var s = new Shape();
    s.vertices = value.vertices;
    s.inTangents = value.inTangents || __zeroTangents(value.vertices);
    s.outTangents = value.outTangents || __zeroTangents(value.vertices);
    s.closed = value.closed !== undefined ? value.closed : true;
    return s;
}

function __shapeToPlainObject(shape) {
    return {
        vertices: shape.vertices,
        inTangents: shape.inTangents,
        outTangents: shape.outTangents,
        closed: shape.closed
    };
}

// Normalizes AE's non-plain value types (Shape, TextDocument) to plain
// JSON-able values; passes everything else through unchanged.
function __normalizePropertyValue(prop, raw) {
    if (__isShapeProperty(prop)) return __shapeToPlainObject(raw);
    if (__isTextDocumentProperty(prop)) return raw.text;
    return raw;
}

// Reads a property's value (at `time` if given, else current), normalized.
// Shared by get_property and set_property so both report values consistently.
function __readPropertyValue(prop, time) {
    var raw = (time !== undefined && time !== null) ? prop.valueAtTime(time, false) : prop.value;
    return __normalizePropertyValue(prop, raw);
}
