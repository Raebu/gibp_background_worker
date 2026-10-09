import type { Env } from "./types"

const encoder = new TextEncoder()

function bytesToBase64(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "")
}

function decodeBase64(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))
}

export function isAuthorized(request: Request, env: Env) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || ""
  return Boolean(env.ADMIN_TOKEN && token && token === env.ADMIN_TOKEN)
}

export function isSiteAuthorized(request: Request, env: Env) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || ""
  return Boolean(env.SITE_EVENT_TOKEN && token && token === env.SITE_EVENT_TOKEN)
}

export async function makeUnsubscribeToken(email: string, env: Env) {
  if (!env.UNSUBSCRIBE_SECRET) throw new Error("UNSUBSCRIBE_SECRET is required")
  const payload = base64Url(encoder.encode(email.toLowerCase()))
  const signature = base64Url(await hmac(env.UNSUBSCRIBE_SECRET, payload))
  return `${payload}.${signature}`
}

export async function readUnsubscribeToken(token: string, env: Env) {
  if (!env.UNSUBSCRIBE_SECRET) return null
  const [payload, signature] = token.split(".")
  if (!payload || !signature) return null
  const expected = await hmac(env.UNSUBSCRIBE_SECRET, payload)
  const received = decodeBase64(signature)
  if (expected.length !== received.length) return null
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i] ^ received[i]
  if (diff !== 0) return null
  try {
    return new TextDecoder().decode(decodeBase64(payload)).toLowerCase()
  } catch {
    return null
  }
}

export async function verifyResendWebhook(request: Request, env: Env, rawBody: string) {
  if (!env.RESEND_WEBHOOK_SECRET) return false
  const id = request.headers.get("svix-id")
  const timestamp = request.headers.get("svix-timestamp")
  const signatureHeader = request.headers.get("svix-signature")
  if (!id || !timestamp || !signatureHeader) return false

  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false

  const secret = env.RESEND_WEBHOOK_SECRET.startsWith("whsec_")
    ? env.RESEND_WEBHOOK_SECRET.slice(6)
    : env.RESEND_WEBHOOK_SECRET

  let secretBytes: Uint8Array
  try {
    secretBytes = decodeBase64(secret)
  } catch {
    return false
  }

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signed = `${id}.${timestamp}.${rawBody}`
  const expected = bytesToBase64(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(signed))),
  )

  return signatureHeader
    .split(" ")
    .map((part) => part.trim())
    .some((part) => part.startsWith("v1,") && part.slice(3) === expected)
}
