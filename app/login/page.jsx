import LoginForm from './LoginForm';

export const metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <div className="narrow">
      <h1 className="page-title">Sign in</h1>
      <LoginForm />
    </div>
  );
}
