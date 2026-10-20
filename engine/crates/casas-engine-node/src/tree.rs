//! A value tree (`casas_engine_api::Value`) as JavaScript values: objects
//! with their keys in order, arrays, numbers, strings, typed arrays.

use std::ffi::CString;
use std::ptr;

use casas_engine_api::Value;
use napi::bindgen_prelude::{
    Float32Array, Float64Array, FromNapiValue, Int8Array, Int16Array, Int32Array, Null,
    ToNapiValue, Uint8Array, Uint16Array, Uint32Array,
};
use napi::{check_status, sys};

pub struct Tree(pub Value);

impl ToNapiValue for Tree {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe { to_js(env, val.0) }
    }
}

unsafe fn to_js(env: sys::napi_env, v: Value) -> napi::Result<sys::napi_value> {
    unsafe {
        match v {
            Value::Null => Null::to_napi_value(env, Null),
            Value::Bool(b) => bool::to_napi_value(env, b),
            Value::Num(n) => f64::to_napi_value(env, n),
            Value::Str(s) => String::to_napi_value(env, s),
            Value::List(items) => {
                let mut array = ptr::null_mut();
                check_status!(sys::napi_create_array_with_length(
                    env,
                    items.len(),
                    &mut array
                ))?;
                for (i, item) in items.into_iter().enumerate() {
                    let value = to_js(env, item)?;
                    check_status!(sys::napi_set_element(env, array, i as u32, value))?;
                }
                Ok(array)
            }
            Value::Obj(entries) => {
                let mut object = ptr::null_mut();
                check_status!(sys::napi_create_object(env, &mut object))?;
                for (key, item) in entries {
                    let value = to_js(env, item)?;
                    let key = CString::new(key.as_ref()).expect("a key has no NUL");
                    check_status!(sys::napi_set_named_property(
                        env,
                        object,
                        key.as_ptr(),
                        value
                    ))?;
                }
                Ok(object)
            }
            Value::F64s(a) => Float64Array::to_napi_value(env, Float64Array::new(a)),
            Value::F32s(a) => Float32Array::to_napi_value(env, Float32Array::new(a)),
            Value::I32s(a) => Int32Array::to_napi_value(env, Int32Array::new(a)),
            Value::I16s(a) => Int16Array::to_napi_value(env, Int16Array::new(a)),
            Value::I8s(a) => Int8Array::to_napi_value(env, Int8Array::new(a)),
            Value::U32s(a) => Uint32Array::to_napi_value(env, Uint32Array::new(a)),
            Value::U16s(a) => Uint16Array::to_napi_value(env, Uint16Array::new(a)),
            Value::U8s(a) => Uint8Array::to_napi_value(env, Uint8Array::new(a)),
        }
    }
}

impl FromNapiValue for Tree {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        unsafe { from_js(env, value).map(Tree) }
    }
}

impl napi::bindgen_prelude::TypeName for Tree {
    fn type_name() -> &'static str {
        "Value"
    }
    fn value_type() -> napi::ValueType {
        napi::ValueType::Unknown
    }
}

impl napi::bindgen_prelude::ValidateNapiValue for Tree {}

/// A JavaScript value as a tree: an object's own enumerable keys in their
/// order, `undefined` as null.
unsafe fn from_js(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Value> {
    unsafe {
        let mut kind = 0;
        check_status!(sys::napi_typeof(env, value, &mut kind))?;
        match kind {
            sys::ValueType::napi_undefined | sys::ValueType::napi_null => Ok(Value::Null),
            sys::ValueType::napi_boolean => bool::from_napi_value(env, value).map(Value::Bool),
            sys::ValueType::napi_number => f64::from_napi_value(env, value).map(Value::Num),
            sys::ValueType::napi_string => String::from_napi_value(env, value).map(Value::Str),
            sys::ValueType::napi_object => {
                let mut typed = false;
                check_status!(sys::napi_is_typedarray(env, value, &mut typed))?;
                if typed {
                    return typed_array(env, value);
                }
                let mut array = false;
                check_status!(sys::napi_is_array(env, value, &mut array))?;
                if array {
                    let mut length = 0;
                    check_status!(sys::napi_get_array_length(env, value, &mut length))?;
                    let mut items = Vec::with_capacity(length as usize);
                    for i in 0..length {
                        let mut item = ptr::null_mut();
                        check_status!(sys::napi_get_element(env, value, i, &mut item))?;
                        items.push(from_js(env, item)?);
                    }
                    return Ok(Value::List(items));
                }
                let mut keys = ptr::null_mut();
                check_status!(sys::napi_get_property_names(env, value, &mut keys))?;
                let mut length = 0;
                check_status!(sys::napi_get_array_length(env, keys, &mut length))?;
                let mut entries = Vec::with_capacity(length as usize);
                for i in 0..length {
                    let mut key = ptr::null_mut();
                    check_status!(sys::napi_get_element(env, keys, i, &mut key))?;
                    let name = String::from_napi_value(env, key)?;
                    let mut item = ptr::null_mut();
                    check_status!(sys::napi_get_property(env, value, key, &mut item))?;
                    entries.push((std::borrow::Cow::Owned(name), from_js(env, item)?));
                }
                Ok(Value::Obj(entries))
            }
            _ => Err(napi::Error::from_reason("a value the engine does not read")),
        }
    }
}

unsafe fn typed_array(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Value> {
    unsafe {
        let mut kind = 0;
        let mut length = 0;
        let mut data = ptr::null_mut();
        let mut buffer = ptr::null_mut();
        let mut offset = 0;
        check_status!(sys::napi_get_typedarray_info(
            env,
            value,
            &mut kind,
            &mut length,
            &mut data,
            &mut buffer,
            &mut offset
        ))?;
        // A typed array's view is aligned to its element (JavaScript
        // requires the byte offset to be a multiple of it).
        fn view<T: Copy>(data: *mut std::ffi::c_void, length: usize) -> Vec<T> {
            if length == 0 {
                return Vec::new();
            }
            unsafe { std::slice::from_raw_parts(data as *const T, length).to_vec() }
        }
        Ok(match kind {
            sys::TypedarrayType::float64_array => Value::F64s(view(data, length)),
            sys::TypedarrayType::float32_array => Value::F32s(view(data, length)),
            sys::TypedarrayType::int32_array => Value::I32s(view(data, length)),
            sys::TypedarrayType::int16_array => Value::I16s(view(data, length)),
            sys::TypedarrayType::int8_array => Value::I8s(view(data, length)),
            sys::TypedarrayType::uint32_array => Value::U32s(view(data, length)),
            sys::TypedarrayType::uint16_array => Value::U16s(view(data, length)),
            sys::TypedarrayType::uint8_array => Value::U8s(view(data, length)),
            _ => {
                return Err(napi::Error::from_reason(
                    "a typed array the engine does not read",
                ));
            }
        })
    }
}
