// One binary min-heap for the two places that need one: the priority flood in
// erosion.ts and the Dijkstra in migration/migrationField.ts. They had grown
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

  push(key: number, index: number): void {
    if (this.size === this.keys.length) this.grow()
    let i = this.size++
    this.keys[i] = key
    this.indices[i] = index
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.keys[parent] <= this.keys[i]) break
      this.swapEntries(parent, i)
      i = parent
    }
  }

  pop(): void {
    // Every caller guards with `length > 0`; an unguarded pop used to walk
    // size negative and leave the last popped entry in place, a silent
    // corruption rather than an error.
    if (this.size === 0) throw new Error('MinHeap.pop on an empty heap')
    this.poppedKey = this.keys[0]
    this.poppedIndex = this.indices[0]
    this.size--
    this.keys[0] = this.keys[this.size]
    this.indices[0] = this.indices[this.size]
    let i = 0
    for (;;) {
      const left = i * 2 + 1
      const right = i * 2 + 2
      let smallest = i
      if (left < this.size && this.keys[left] < this.keys[smallest]) smallest = left
      if (right < this.size && this.keys[right] < this.keys[smallest]) smallest = right
      if (smallest === i) break
      this.swapEntries(smallest, i)
      i = smallest
    }
  }

  private grow(): void {
    const keys = new Float64Array(this.keys.length * 2)
    const indices = new Int32Array(this.indices.length * 2)
    keys.set(this.keys)
    indices.set(this.indices)
    this.keys = keys
    this.indices = indices
  }

  private swapEntries(a: number, b: number): void {
    const tempKey = this.keys[a]
    this.keys[a] = this.keys[b]
    this.keys[b] = tempKey
    const tempIndex = this.indices[a]
    this.indices[a] = this.indices[b]
    this.indices[b] = tempIndex
  }
}
