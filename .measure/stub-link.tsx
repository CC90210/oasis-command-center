/**
 * next/link, minus the router. Renders the same <a> element with the same
 * href, which is all the geometry depends on. Importing the real one pulls in
 * the App Router context, which does not exist outside a Next runtime.
 */
import * as React from "react";

type Props = React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean };

export default function Link({ href, prefetch: _prefetch, children, ...rest }: Props) {
  return <a href={href} {...rest}>{children}</a>;
}
