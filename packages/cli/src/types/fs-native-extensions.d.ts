declare module "fs-native-extensions" {
  export function tryLock(fd: number, offset: number, length: number, options: { shared: false }): boolean;
}
