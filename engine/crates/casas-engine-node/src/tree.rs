//! A value tree (`casas_engine_api::Value`) as JavaScript values: objects
//! with their keys in order, arrays, numbers, strings, typed arrays.

use std::ffi::CString;
use std::ptr;

use casas_engine_api::Value;
use napi::bindgen_prelude::{
    Float32Array, Float64Array, Int8Array, Int16Array, Int32Array, Null, ToNapiValue, Uint8Array,
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
                    let key = CString::new(key).expect("a key has no NUL");
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
            Value::U8s(a) => Uint8Array::to_napi_value(env, Uint8Array::new(a)),
        }
    }
}
