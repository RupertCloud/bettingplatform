import ForgotForm from './ForgotForm';

export const metadata = { title: 'Forgot password' };

export default function ForgotPasswordPage() {
  return (
    <div className="narrow">
      <h1 className="page-title">Forgot password</h1>
      <p className="muted">Enter the email on your account and we will send you a reset link.</p>
      <ForgotForm />
    </div>
  );
}
