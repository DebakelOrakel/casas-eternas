//! A value tree (`casas_engine_api::Value`) as JavaScript values: objects
//! with their keys in order, arrays, numbers, strings, typed arrays
//! (copies out of the module's memory).

use casas_engine_api::Value;
use js_sys::{
    Array, Float32Array, Float64Array, Int8Array, Int16Array, Int32Array, Object, Reflect,
    Uint8Array,
};
use wasm_bindgen::JsValue;

pub fn to_js(v: Value) -> JsValue {
    match v {
        Value::Null => JsValue::NULL,
        Value::Bool(b) => JsValue::from_bool(b),
        Value::Num(n) => JsValue::from_f64(n),
        Value::Str(s) => JsValue::from_str(&s),
        Value::List(items) => {
            let array = Array::new_with_length(items.len() as u32);
            for (i, item) in items.into_iter().enumerate() {
                array.set(i as u32, to_js(item));
            }
            array.into()
        }
        Value::Obj(entries) => {
            let object = Object::new();
            for (key, item) in entries {
                Reflect::set(&object, &JsValue::from_str(key), &to_js(item))
                    .expect("a plain object takes a key");
            }
            object.into()
        }
        Value::F64s(a) => Float64Array::from(&a[..]).into(),
        Value::F32s(a) => Float32Array::from(&a[..]).into(),
        Value::I32s(a) => Int32Array::from(&a[..]).into(),
        Value::I16s(a) => Int16Array::from(&a[..]).into(),
        Value::I8s(a) => Int8Array::from(&a[..]).into(),
        Value::U8s(a) => Uint8Array::from(&a[..]).into(),
    }
}
