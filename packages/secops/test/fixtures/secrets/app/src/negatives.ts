// None of these lines is a secret.
const apiKey = process.env.API_KEY;
const githubToken = "your-github-token-here";
const SECRET_KEY = "changeme-please-change";
const placeholder = { password: "<your-password>" };
const repeated = { token: "aaaaaaaaaaaaaaaaaaaaaaaa" };
type Login = { password: string };
const tokenUrl = "https://auth.example.com/oauth/token";
const passwordField = "user_password_input_field";
const authToken = `Bearer ${apiKey}`;
const anon = "{{FAKE:supabase-anon-jwt}}";
export { githubToken, SECRET_KEY, placeholder, repeated, tokenUrl, passwordField, authToken, anon };
export type { Login };
