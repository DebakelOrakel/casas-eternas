// One binary min-heap for the two places that need one: the priority flood in
// flowRouting.ts and the erosion engine, and the Dijkstra in migration/migrationField.ts. They had grown
// separate implementations of the same structure — one typed-array-backed with a
// fixed capacity, one plain-array-backed and growable — differing only in the
// details each happened to need.
//
// Merging them needed care, because a min-heap's only job is to compare keys and
// two of the differences were not cosmetic:
//
//  - **Key precision.** erosion stored keys in a Float32Array, migration in a
//    number[] (i.e. float64). Widening to float64 for both is safe HERE, and only
//    because of where the keys come from: every key erosion pushes is read
//    straight out of `filled`, itself a Float32Array, so the value is already
//    float32-representable and widening it is lossless. Nothing is truncated on
//    the way in, so no two distinct values can collapse into a tie that would
//    reorder pops. Narrowing migration's costs to float32 would NOT have been
//    safe, which is why this is a Float64Array.
//  - **Capacity.** erosion pushes each cell at most once (the flood's `visited`
//    guard), so cellCount was enough. A lazy-deletion Dijkstra re-pushes a cell
//    on every improvement, so it needs to grow. Growth is numerically inert, so
//    the growable version is safe for both.
//
// `pop()` writes its result into poppedKey/poppedIndex rather than returning an
// object — the flood runs this up to ~2M times per erosion pass, and an
// allocation per pop is real GC pressure at that scale. migration's old version
// did allocate; reading the fields instead is a straight win for it.
export class MinHeap {
  private keys: Float64Array
  private indices: Int32Array
  private size = 0
  poppedKey = 0
  poppedIndex = -1

  // `capacity` is a hint, not a limit — push() grows past it. Sizing it right
  // just avoids the copies.
  constructor(capacity: number) {
    const initial = Math.max(1, capacity)
    this.keys = new Float64Array(initial)
    this.indices = new Int32Array(initial)
  }

  get length(): number {
    return this.size
  }

  // Both sifts move a hole instead of swapping (the entry being placed is
  // written once, where it stops): the same comparisons against the same
  // keys, so every entry ends where the swaps put it — the pop order, ties
  // included, is the swapping heap's (2026-10-15; the swaps were a third
  // of the flood's time).
  push(key: number, index: number): void {
    if (this.size === this.keys.length) this.grow()
    const keys = this.keys
    const indices = this.indices
    let i = this.size++
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (keys[parent] <= key) break
      keys[i] = keys[parent]
      indices[i] = indices[parent]
      i = parent
    }
    keys[i] = key
    indices[i] = index
  }

  pop(): void {
    // Every caller guards with `length > 0`; an unguarded pop used to walk
    // size negative and leave the last popped entry in place, a silent
    // corruption rather than an error.
    if (this.size === 0) throw new Error('MinHeap.pop on an empty heap')
    const keys = this.keys
    const indices = this.indices
    this.poppedKey = keys[0]
    this.poppedIndex = indices[0]
    const size = --this.size
    const key = keys[size]
    const index = indices[size]
    let i = 0
    for (;;) {
      const left = i * 2 + 1
      const right = i * 2 + 2
      let smallest = i
      let smallestKey = key
      if (left < size && keys[left] < smallestKey) { smallest = left; smallestKey = keys[left] }
      if (right < size && keys[right] < smallestKey) smallest = right
      if (smallest === i) break
      keys[i] = keys[smallest]
      indices[i] = indices[smallest]
      i = smallest
    }
    keys[i] = key
    indices[i] = index
  }

  private grow(): void {
    const keys = new Float64Array(this.keys.length * 2)
    const indices = new Int32Array(this.indices.length * 2)
    keys.set(this.keys)
    indices.set(this.indices)
    this.keys = keys
    this.indices = indices
  }
}
