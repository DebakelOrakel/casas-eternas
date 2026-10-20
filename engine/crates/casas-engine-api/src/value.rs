//! The plain data that crosses to TypeScript: a value tree the bindings
//! turn into JavaScript values one for one — objects with their keys in
//! the order given, arrays, numbers, strings, typed arrays. A shape here
//! is the TypeScript type's it stands for (docs/decisions/rust-engine.md,
//! fork 6c: the engine gives data, the world layer writes the files).

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    List(Vec<Value>),
    /// An object, its keys in this order; a key whose value TypeScript
    /// leaves out (an optional field) is not in the list.
    Obj(Vec<(&'static str, Value)>),
    F64s(Vec<f64>),
    F32s(Vec<f32>),
    I32s(Vec<i32>),
    I16s(Vec<i16>),
    I8s(Vec<i8>),
    U8s(Vec<u8>),
}

impl Value {
    pub fn num<T: Into<f64>>(v: T) -> Value {
        Value::Num(v.into())
    }

    /// A list of numbers as a plain array (not a typed one).
    pub fn nums<T: Copy + Into<f64>>(v: &[T]) -> Value {
        Value::List(v.iter().map(|&x| Value::Num(x.into())).collect())
    }

    pub fn str_or_null(v: &Option<String>) -> Value {
        v.as_ref().map_or(Value::Null, |s| Value::Str(s.clone()))
    }
}

/// An object built key by key, optional keys left out when None.
#[derive(Default)]
pub struct ObjBuilder(Vec<(&'static str, Value)>);

impl ObjBuilder {
    pub fn new() -> Self {
        ObjBuilder(Vec::new())
    }

    pub fn put(mut self, key: &'static str, value: Value) -> Self {
        self.0.push((key, value));
        self
    }

    pub fn num<T: Into<f64>>(self, key: &'static str, v: T) -> Self {
        self.put(key, Value::Num(v.into()))
    }

    pub fn opt_num<T: Into<f64>>(self, key: &'static str, v: Option<T>) -> Self {
        match v {
            Some(v) => self.num(key, v),
            None => self,
        }
    }

    pub fn opt(self, key: &'static str, v: Option<Value>) -> Self {
        match v {
            Some(v) => self.put(key, v),
            None => self,
        }
    }

    pub fn build(self) -> Value {
        Value::Obj(self.0)
    }
}
