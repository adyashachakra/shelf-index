export function useRouter() {
  return { push: (_: string) => undefined, replace: (_: string) => undefined };
}
export function notFound(): never {
  throw new Error('NOT_FOUND');
}
export function redirect(path: string): never {
  throw new Error(`REDIRECT ${path}`);
}
