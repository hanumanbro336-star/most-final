'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'

type Mode = 'sign-in' | 'sign-up'

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter()
  const isSignUp = mode === 'sign-up'
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setError('')
    setPending(true)

    const result = isSignUp
      ? await authClient.signUp.email({ email, password, name })
      : await authClient.signIn.email({ email, password })

    if (result.error) {
      console.error('[v0] auth request failed', result.error)
      setError(
        isSignUp
          ? 'Could not create your account. Try a different email.'
          : 'Incorrect email or password.'
      )
      setPending(false)
      return
    }

    router.push('/console')
    router.refresh()
  }

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-sm flex-col justify-center gap-8 px-6 py-10">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-[11px] tracking-[0.28em] text-muted-foreground">FORGE</p>
        <h1 className="text-2xl font-medium tracking-tight text-pretty">
          {isSignUp ? 'Create your account' : 'Sign in to the console'}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {isSignUp
            ? 'Pair a laptop first, then sign in to drive it from the console.'
            : 'The device console is gated. Sign in to reach it.'}
        </p>
      </header>

      <form onSubmit={onSubmit} noValidate>
        <FieldGroup>
          {isSignUp ? (
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input
                id="name"
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                required
              />
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              spellCheck={false}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isSignUp ? 'new-password' : 'current-password'}
              minLength={8}
              required
            />
          </Field>
          {error ? <FieldError>{error}</FieldError> : null}
          <Button type="submit" size="lg" disabled={pending}>
            {pending ? <Spinner /> : null}
            {isSignUp ? 'Create account' : 'Sign in'}
          </Button>
        </FieldGroup>
      </form>

      <p className="text-sm text-muted-foreground">
        {isSignUp ? 'Already have an account? ' : 'Need an account? '}
        <Link
          href={isSignUp ? '/sign-in' : '/sign-up'}
          className="text-foreground underline underline-offset-4"
        >
          {isSignUp ? 'Sign in' : 'Sign up'}
        </Link>
      </p>
    </main>
  )
}
