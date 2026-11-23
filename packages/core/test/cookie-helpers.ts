// SPDX-License-Identifier: Apache-2.0
import { sha256Hex } from "../src/crypto";

export const handoffCookieName = async (token: string, secure = true): Promise<string> =>
  `${secure ? "__Secure-" : ""}rose_handoff_${(await sha256Hex(token)).slice(0, 16)}`;

export const cookiePair = (res: Response, name: string): string =>
  (res.headers.getSetCookie().find((s) => s.startsWith(`${name}=`)) ?? "").split(";")[0]!;

export const hasCookie = (res: Response, name: string): boolean =>
  res.headers.getSetCookie().some((s) => s.startsWith(`${name}=`));
