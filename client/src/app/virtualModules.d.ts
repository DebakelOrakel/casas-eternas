// Modules vite.config.ts's plugins make.
declare module 'virtual:generator-code' {
  const code: string
  export default code
}

declare module 'virtual:handbook' {
  const handbook: import('../ui/handbook/handbookTypes').Handbook
  export default handbook
}
