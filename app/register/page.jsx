import RegisterForm from './RegisterForm';

export const metadata = { title: 'Create an account' };

export default function RegisterPage() {
  return (
    <div className="narrow">
      <h1 className="page-title">Create an account</h1>
      <p className="muted">You must be 18 or older and live in Cameroon.</p>
      <RegisterForm />
    </div>
  );
}
