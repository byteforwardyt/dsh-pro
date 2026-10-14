/**
 * Byte Forward subscribe action — node half.
 *
 * This package contributes browser presentation only. The empty `apply` gives the
 * Loader a host-side row, which is what makes the package visible to the client
 * module scan; the browser half ships through `exports["./client"]`.
 */
export function apply () {}
