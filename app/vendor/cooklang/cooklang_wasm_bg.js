export class FallibleResult {
    static __wrap(ptr) {
        const obj = Object.create(FallibleResult.prototype);
        obj.__wbg_ptr = ptr;
        FallibleResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FallibleResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fallibleresult_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get error() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.__wbg_get_fallibleresult_error(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get value() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.__wbg_get_fallibleresult_value(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {string} arg0
     */
    set error(arg0) {
        const ptr0 = passStringToWasm0(arg0, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.__wbg_set_fallibleresult_error(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} arg0
     */
    set value(arg0) {
        const ptr0 = passStringToWasm0(arg0, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.__wbg_set_fallibleresult_value(this.__wbg_ptr, ptr0, len0);
    }
}
if (Symbol.dispose) FallibleResult.prototype[Symbol.dispose] = FallibleResult.prototype.free;

export class Parser {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ParserFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_parser_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get extensions() {
        const ret = wasm.parser_extensions(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * returns vector of indices in r.recipe.cookware and their quantities
     * @param {ScaledRecipeWithReport} r
     * @returns {GroupedIndexAndQuantity[]}
     */
    group_cookware(r) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.parser_group_cookware(retptr, this.__wbg_ptr, addBorrowedObject(r));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayJsValueFromWasm0(r0, r1);
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            heap[stack_pointer++] = undefined;
        }
    }
    /**
     * returns vector of indices in r.recipe.ingredients and their quantities
     * @param {ScaledRecipeWithReport} r
     * @returns {GroupedIndexAndQuantity[]}
     */
    group_ingredients(r) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.parser_group_ingredients(retptr, this.__wbg_ptr, addBorrowedObject(r));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayJsValueFromWasm0(r0, r1);
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            heap[stack_pointer++] = undefined;
        }
    }
    /**
     * @returns {boolean}
     */
    get load_units() {
        const ret = wasm.parser_load_units(this.__wbg_ptr);
        return ret !== 0;
    }
    constructor() {
        const ret = wasm.parser_new();
        this.__wbg_ptr = ret;
        ParserFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {string} input
     * @param {number | null} [scale]
     * @returns {ScaledRecipeWithReport}
     */
    parse(input, scale) {
        const ptr0 = passStringToWasm0(input, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.parser_parse(this.__wbg_ptr, ptr0, len0, !isLikeNone(scale), isLikeNone(scale) ? 0 : scale);
        return takeObject(ret);
    }
    /**
     * @param {string} input
     * @param {boolean} json
     * @returns {FallibleResult}
     */
    parse_ast(input, json) {
        const ptr0 = passStringToWasm0(input, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.parser_parse_ast(this.__wbg_ptr, ptr0, len0, json);
        return FallibleResult.__wrap(ret);
    }
    /**
     * @param {string} input
     * @returns {string}
     */
    parse_events(input) {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(input, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.parser_parse_events(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred2_0 = r0;
            deferred2_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} input
     * @param {boolean} json
     * @returns {FallibleResult}
     */
    parse_full(input, json) {
        const ptr0 = passStringToWasm0(input, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.parser_parse_full(this.__wbg_ptr, ptr0, len0, json);
        return FallibleResult.__wrap(ret);
    }
    /**
     * @param {string} input
     * @param {number | null} [scale]
     * @returns {FallibleResult}
     */
    parse_render(input, scale) {
        const ptr0 = passStringToWasm0(input, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.parser_parse_render(this.__wbg_ptr, ptr0, len0, !isLikeNone(scale), isLikeNone(scale) ? 0 : scale);
        return FallibleResult.__wrap(ret);
    }
    /**
     * @param {number} bits
     */
    set extensions(bits) {
        wasm.parser_set_extensions(this.__wbg_ptr, bits);
    }
    /**
     * @param {boolean} load
     */
    set load_units(load) {
        wasm.parser_set_load_units(this.__wbg_ptr, load);
    }
    /**
     * @param {string} input
     * @returns {FallibleResult}
     */
    std_metadata(input) {
        const ptr0 = passStringToWasm0(input, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.parser_std_metadata(this.__wbg_ptr, ptr0, len0);
        return FallibleResult.__wrap(ret);
    }
}
if (Symbol.dispose) Parser.prototype[Symbol.dispose] = Parser.prototype.free;

/**
 * @param {Cookware} _this
 * @returns {string}
 */
export function cookware_display_name(_this) {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.cookware_display_name(retptr, addBorrowedObject(_this));
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        heap[stack_pointer++] = undefined;
        wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Whether the cookware item is marked optional (`#?name`)
 * @param {Cookware} _this
 * @returns {boolean}
 */
export function cookware_is_optional(_this) {
    try {
        const ret = wasm.cookware_is_optional(addBorrowedObject(_this));
        return ret !== 0;
    } finally {
        heap[stack_pointer++] = undefined;
    }
}

/**
 * @param {Cookware} _this
 * @returns {boolean}
 */
export function cookware_should_be_listed(_this) {
    try {
        const ret = wasm.cookware_should_be_listed(addBorrowedObject(_this));
        return ret !== 0;
    } finally {
        heap[stack_pointer++] = undefined;
    }
}

/**
 * @param {GroupedQuantity} _this
 * @returns {string}
 */
export function grouped_quantity_display(_this) {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.grouped_quantity_display(retptr, addBorrowedObject(_this));
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        heap[stack_pointer++] = undefined;
        wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
    }
}

/**
 * @param {GroupedQuantity} _this
 * @returns {boolean}
 */
export function grouped_quantity_is_empty(_this) {
    try {
        const ret = wasm.grouped_quantity_is_empty(addBorrowedObject(_this));
        return ret !== 0;
    } finally {
        heap[stack_pointer++] = undefined;
    }
}

/**
 * @param {Ingredient} _this
 * @returns {string}
 */
export function ingredient_display_name(_this) {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.ingredient_display_name(retptr, addBorrowedObject(_this));
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        heap[stack_pointer++] = undefined;
        wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Whether the ingredient is marked optional (`@?name`)
 * @param {Ingredient} _this
 * @returns {boolean}
 */
export function ingredient_is_optional(_this) {
    try {
        const ret = wasm.ingredient_is_optional(addBorrowedObject(_this));
        return ret !== 0;
    } finally {
        heap[stack_pointer++] = undefined;
    }
}

/**
 * @param {Ingredient} _this
 * @returns {boolean}
 */
export function ingredient_should_be_listed(_this) {
    try {
        const ret = wasm.ingredient_should_be_listed(addBorrowedObject(_this));
        return ret !== 0;
    } finally {
        heap[stack_pointer++] = undefined;
    }
}

/**
 * @param {Quantity} _this
 * @returns {string}
 */
export function quantity_display(_this) {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.quantity_display(retptr, addBorrowedObject(_this));
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        heap[stack_pointer++] = undefined;
        wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
    }
}

/**
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.version(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
    }
}
export function __wbg___wbindgen_is_undefined_8865fb403f8fe9d8(arg0) {
    const ret = getObject(arg0) === undefined;
    return ret;
}
export function __wbg___wbindgen_string_get_0380ccaa2f57f0d9(arg0, arg1) {
    const obj = getObject(arg1);
    const ret = typeof(obj) === 'string' ? obj : undefined;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_throw_41e9ee4f547fc59a(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
}
export function __wbg_parse_0fc53dead14b3b42() { return handleError(function (arg0, arg1) {
    const ret = JSON.parse(getStringFromWasm0(arg0, arg1));
    return addHeapObject(ret);
}, arguments); }
export function __wbg_stringify_52ff602c1cc4fbb6() { return handleError(function (arg0) {
    const ret = JSON.stringify(getObject(arg0));
    return addHeapObject(ret);
}, arguments); }
export function __wbindgen_object_clone_ref(arg0) {
    const ret = getObject(arg0);
    return addHeapObject(ret);
}
export function __wbindgen_object_drop_ref(arg0) {
    takeObject(arg0);
}
const FallibleResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fallibleresult_free(ptr, 1));
const ParserFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_parser_free(ptr, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function addBorrowedObject(obj) {
    if (stack_pointer == 1) throw new Error('out of js stack');
    heap[--stack_pointer] = obj;
    return stack_pointer;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(takeObject(mem.getUint32(i, true)));
    }
    return result;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        wasm.__wbindgen_export3(addHeapObject(e));
    }
}

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let stack_pointer = 1024;

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
