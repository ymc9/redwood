import crypto from 'node:crypto'

import type { APIGatewayProxyEvent } from 'aws-lambda'

import { getConfig, getConfigPath } from '@redwoodjs/project-config'

import * as DbAuthError from './errors'

type ScryptOptions = {
  cost?: number
  blockSize?: number
  parallelization?: number
  N?: number
  r?: number
  p?: number
  maxmem?: number
}

const DEFAULT_SCRYPT_OPTIONS: ScryptOptions = {
  cost: 2 ** 14,
  blockSize: 8,
  parallelization: 1,
}

// Extracts the cookie from an event, handling lower and upper case header names.
const eventHeadersCookie = (event: APIGatewayProxyEvent) => {
  return event.headers.cookie || event.headers.Cookie
}

const getPort = () => {
  let configPath

  try {
    configPath = getConfigPath()
  } catch {
    // If this throws, we're in a serverless environment, and the `redwood.toml` file doesn't exist.
    return 8911
  }

  return getConfig(configPath).api.port
}

// When in development environment, check for cookie in the request extension headers
// if user has generated graphiql headers
const eventGraphiQLHeadersCookie = (event: APIGatewayProxyEvent) => {
  if (process.env.NODE_ENV === 'development') {
    try {
      const jsonBody = JSON.parse(event.body ?? '{}')
      return (
        jsonBody?.extensions?.headers?.cookie ||
        jsonBody?.extensions?.headers?.Cookie
      )
    } catch {
      // sometimes the event body isn't json
      return
    }
  }

  return
}

// decrypts session text using old CryptoJS algorithm (using node:crypto library)
const legacyDecryptSession = (encryptedText: string) => {
  const cypher = Buffer.from(encryptedText, 'base64')
  const salt = cypher.slice(8, 16)
  const password = Buffer.concat([
    Buffer.from(process.env.SESSION_SECRET as string, 'binary'),
    salt,
  ])
  const md5Hashes = []
  let digest = password
  for (let i = 0; i < 3; i++) {
    md5Hashes[i] = crypto.createHash('md5').update(digest).digest()
    digest = Buffer.concat([md5Hashes[i], password])
  }
  const key = Buffer.concat([md5Hashes[0], md5Hashes[1]])
  const iv = md5Hashes[2]
  const contents = cypher.slice(16)
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)

  return decipher.update(contents) + decipher.final('utf-8')
}

// Extracts the session cookie from an event, handling both
// development environment GraphiQL headers and production environment headers.
export const extractCookie = (event: APIGatewayProxyEvent) => {
  return eventGraphiQLHeadersCookie(event) || eventHeadersCookie(event)
}

// whether this encrypted session was made with the old CryptoJS algorithm
export const isLegacySession = (text: string | undefined) => {
  if (!text) {
    return false
  }

  const [_encryptedText, iv] = text.split('|')
  return !iv
}

// decrypts the session cookie and returns an array: [data, csrf]
export const decryptSession = (text: string | null) => {
  if (!text || text.trim() === '') {
    return []
  }

  let decoded
  // if cookie contains a pipe then it was encrypted using the `node:crypto`
  // algorithm (first element is the ecrypted data, second is the initialization vector)
  // otherwise fall back to using the older CryptoJS algorithm
  const [encryptedText, iv] = text.split('|')

  try {
    if (iv) {
      // decrypt using the `node:crypto` algorithm
      const decipher = crypto.createDecipheriv(
        'aes-256-cbc',
        (process.env.SESSION_SECRET as string).substring(0, 32),
        Buffer.from(iv, 'base64')
      )
      decoded =
        decipher.update(encryptedText, 'base64', 'utf-8') +
        decipher.final('utf-8')
    } else {
      decoded = legacyDecryptSession(text)
    }

    const [data, csrf] = decoded.split(';')
    const json = JSON.parse(data)

    return [json, csrf]
  } catch (e) {
    throw new DbAuthError.SessionDecryptionError()
  }
}

export const encryptSession = (dataString: string) => {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(
    'aes-256-cbc',
    (process.env.SESSION_SECRET as string).substring(0, 32),
    iv
  )
  let encryptedData = cipher.update(dataString, 'utf-8', 'base64')
  encryptedData += cipher.final('base64')

  return `${encryptedData}|${iv.toString('base64')}`
}

// returns the actual value of the session cookie
export const getSession = (
  text: string | undefined,
  cookieNameOption: string | undefined
) => {
  if (typeof text === 'undefined' || text === null) {
    return null
  }

  const cookies = text.split(';')
  const sessionCookie = cookies.find((cookie) => {
    return cookie.split('=')[0].trim() === cookieName(cookieNameOption)
  })

  if (!sessionCookie || sessionCookie === `${cookieName(cookieNameOption)}=`) {
    return null
  }

  return sessionCookie.replace(`${cookieName(cookieNameOption)}=`, '').trim()
}

// Convenience function to get session, decrypt, and return session data all
// at once. Accepts the `event` argument from a Lambda function call and the
// name of the dbAuth session cookie
export const dbAuthSession = (
  event: APIGatewayProxyEvent,
  cookieNameOption: string | undefined
) => {
  if (extractCookie(event)) {
    const [session, _csrfToken] = decryptSession(
      getSession(extractCookie(event), cookieNameOption)
    )
    return session
  } else {
    return null
  }
}

export const webAuthnSession = (event: APIGatewayProxyEvent) => {
  if (!event.headers.cookie) {
    return null
  }

  const webAuthnCookie = event.headers.cookie.split(';').find((cook) => {
    return cook.split('=')[0].trim() === 'webAuthn'
  })

  if (!webAuthnCookie || webAuthnCookie === 'webAuthn=') {
    return null
  }

  return webAuthnCookie.split('=')[1].trim()
}

export const hashToken = (token: string) => {
  return crypto.createHash('sha256').update(token).digest('hex')
}

// hashes a password using either the given `salt` argument, or creates a new
// salt and hashes using that. Either way, returns an array with [hash, salt]
// normalizes the string in case it contains unicode characters: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/normalize
// TODO: Add validation that the options are valid values for the scrypt algorithm
export const hashPassword = (
  text: string,
  {
    salt = crypto.randomBytes(32).toString('hex'),
    options = DEFAULT_SCRYPT_OPTIONS,
  }: { salt?: string; options?: ScryptOptions } = {}
) => {
  const encryptedString = crypto
    .scryptSync(text.normalize('NFC'), salt, 32, options)
    .toString('hex')
  const optionsToString = [
    options.cost,
    options.blockSize,
    options.parallelization,
  ]
  return [`${encryptedString}|${optionsToString.join('|')}`, salt]
}

// uses the old algorithm from CryptoJS:
//   CryptoJS.PBKDF2(password, salt, { keySize: 8 }).toString()
export const legacyHashPassword = (text: string, salt?: string) => {
  const useSalt = salt || crypto.randomBytes(32).toString('hex')
  return [
    crypto.pbkdf2Sync(text, useSalt, 1, 32, 'SHA1').toString('hex'),
    useSalt,
  ]
}

export const cookieName = (name: string | undefined) => {
  const port = getPort()
  const cookieName = name?.replace('%port%', '' + port) ?? 'session'

  return cookieName
}

export const extractHashingOptions = (text: string): ScryptOptions => {
  const [_hash, ...options] = text.split('|')

  if (options.length === 3) {
    return {
      cost: parseInt(options[0]),
      blockSize: parseInt(options[1]),
      parallelization: parseInt(options[2]),
    }
  } else {
    return {}
  }
}
