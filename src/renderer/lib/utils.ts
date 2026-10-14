import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function toHex(bytes: number[] | Uint8Array, sep = " "): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(sep)
}

export function fromHex(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "")
  if (clean.length % 2 !== 0) throw new Error("Odd-length hex string")
  const out: number[] = []
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16))
  return out
}

export function nowIso(): string {
  return new Date().toISOString()
}
