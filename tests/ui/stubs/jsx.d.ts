// Stand-ins for the typings that @types/react and Next.js provide in a real install.
// They exist only so the page and component code can be type-checked where those packages
// are not installed. They are far looser than the real typings.
declare namespace JSX {
  type Element = import('react').ReactElement;
  interface IntrinsicAttributes {
    key?: string | number | null;
  }
  interface LooseDomProps {
    onSubmit?: (event: { preventDefault(): void }) => void;
    onChange?: (event: { target: { value: string } }) => void;
    onClick?: (event: unknown) => void;
    [prop: string]: any;
  }
  interface IntrinsicElements {
    [name: string]: LooseDomProps;
  }
  interface ElementChildrenAttribute {
    children: {};
  }
}
declare module '*.css';
declare module 'react' {
  export interface ReactElement {
    type: unknown;
    props: unknown;
    key: string | null;
  }
  export type ReactNode = ReactElement | string | number | bigint | boolean | null | undefined | Iterable<ReactNode>;
  export function useState<S>(initial: S | (() => S)): [S, (value: S | ((previous: S) => S)) => void];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useRef<T>(initial: T): { current: T };
}
declare module 'react/jsx-runtime' {
  export const jsx: unknown;
  export const jsxs: unknown;
  export const Fragment: unknown;
}
declare module 'react-dom/server' {
  export function renderToStaticMarkup(node: unknown): string;
}
