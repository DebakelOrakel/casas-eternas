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
                Reflect::set(&object, &JsValue::from_str(&key), &to_js(item))
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

/// A JavaScript value as a tree: an object's own enumerable keys in their
/// order, `undefined` as null; typed arrays copied into the module.
pub fn from_js(v: &JsValue) -> Result<Value, wasm_bindgen::JsError> {
    use wasm_bindgen::JsCast;
    if v.is_null() || v.is_undefined() {
        return Ok(Value::Null);
    }
    if let Some(b) = v.as_bool() {
        return Ok(Value::Bool(b));
    }
    if let Some(n) = v.as_f64() {
        return Ok(Value::Num(n));
    }
    if let Some(s) = v.as_string() {
        return Ok(Value::Str(s));
    }
    if let Some(a) = v.dyn_ref::<Float64Array>() {
        return Ok(Value::F64s(a.to_vec()));
    }
    if let Some(a) = v.dyn_ref::<Float32Array>() {
        return Ok(Value::F32s(a.to_vec()));
    }
    if let Some(a) = v.dyn_ref::<Int32Array>() {
        return Ok(Value::I32s(a.to_vec()));
    }
    if let Some(a) = v.dyn_ref::<Int16Array>() {
        return Ok(Value::I16s(a.to_vec()));
    }
    if let Some(a) = v.dyn_ref::<Int8Array>() {
        return Ok(Value::I8s(a.to_vec()));
    }
    if let Some(a) = v.dyn_ref::<Uint8Array>() {
        return Ok(Value::U8s(a.to_vec()));
    }
    if Array::is_array(v) {
        let a: &Array = v.unchecked_ref();
        return a
            .iter()
            .map(|x| from_js(&x))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::List);
    }
    if v.is_object() {
        let object: &Object = v.unchecked_ref();
        let mut entries = Vec::new();
        for key in Object::keys(object).iter() {
            let name = key.as_string().unwrap_or_default();
            let item = Reflect::get(object, &key)
                .map_err(|_| wasm_bindgen::JsError::new("a key the engine cannot read"))?;
            entries.push((std::borrow::Cow::Owned(name), from_js(&item)?));
        }
        return Ok(Value::Obj(entries));
    }
    Err(wasm_bindgen::JsError::new(
        "a value the engine does not read",
    ))
}
