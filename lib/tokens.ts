import crypto from 'crypto'

export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString('hex')
}
