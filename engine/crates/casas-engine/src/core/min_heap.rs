//! `core/minHeap.ts`: the binary min-heap of the priority flood and the
//! Dijkstras. Both sifts move a hole; the pop order, ties included, is the
//! TypeScript heap's.

pub struct MinHeap {
    keys: Vec<f64>,
    indices: Vec<i32>,
    pub popped_key: f64,
    pub popped_index: i32,
}

impl MinHeap {
    /// `capacity` is a hint; `push` grows past it.
    pub fn new(capacity: usize) -> Self {
        MinHeap {
            keys: Vec::with_capacity(capacity.max(1)),
            indices: Vec::with_capacity(capacity.max(1)),
            popped_key: 0.0,
            popped_index: -1,
        }
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    pub fn push(&mut self, key: f64, index: i32) {
        self.keys.push(key);
        self.indices.push(index);
        let mut i = self.keys.len() - 1;
        while i > 0 {
            let parent = (i - 1) >> 1;
            if self.keys[parent] <= key {
                break;
            }
            self.keys[i] = self.keys[parent];
            self.indices[i] = self.indices[parent];
            i = parent;
        }
        self.keys[i] = key;
        self.indices[i] = index;
    }

    /// Pops the least entry into `popped_key` / `popped_index`; panics on an
    /// empty heap.
    pub fn pop(&mut self) {
        assert!(!self.keys.is_empty(), "MinHeap.pop on an empty heap");
        self.popped_key = self.keys[0];
        self.popped_index = self.indices[0];
        let key = self.keys.pop().unwrap();
        let index = self.indices.pop().unwrap();
        let size = self.keys.len();
        if size == 0 {
            return;
        }
        let mut i = 0;
        loop {
            let left = i * 2 + 1;
            let right = i * 2 + 2;
            let mut smallest = i;
            let mut smallest_key = key;
            if left < size && self.keys[left] < smallest_key {
                smallest = left;
                smallest_key = self.keys[left];
            }
            if right < size && self.keys[right] < smallest_key {
                smallest = right;
            }
            if smallest == i {
                break;
            }
            self.keys[i] = self.keys[smallest];
            self.indices[i] = self.indices[smallest];
            i = smallest;
        }
        self.keys[i] = key;
        self.indices[i] = index;
    }
}
