import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const email = process.env.E2E_TEST_EMAIL
const password = process.env.E2E_TEST_PASSWORD

if (!supabaseUrl || !serviceRoleKey || !email || !password) {
  throw new Error('Local Supabase URL, service-role key, and E2E credentials are required')
}

const target = new URL(supabaseUrl)
if (!['127.0.0.1', 'localhost'].includes(target.hostname)) {
  throw new Error('E2E user provisioning is restricted to localhost Supabase instances')
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const { data, error } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: {
    full_name: 'Campus Plug E2E Student',
    university: 'University of Lagos (UNILAG)',
    department: 'Computer Science',
    course: 'Software Engineering',
  },
})

if (error) throw new Error(`Unable to create isolated E2E user: ${error.message}`)
if (!data.user) throw new Error('Supabase Auth did not return the E2E user')

const { error: profileError } = await admin
  .from('profiles')
  .upsert({
    id: data.user.id,
    email,
    full_name: 'Campus Plug E2E Student',
    university: 'University of Lagos (UNILAG)',
    department: 'Computer Science',
    course: 'Software Engineering',
    is_verified: false,
  }, { onConflict: 'id' })

if (profileError) throw new Error(`Unable to provision E2E profile: ${profileError.message}`)

process.stdout.write('Created isolated local Supabase E2E student.\n')
