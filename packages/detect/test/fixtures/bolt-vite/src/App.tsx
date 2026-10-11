export default function App() {
  const apiUrl = import.meta.env.VITE_API_URL;
  return <p>API: {apiUrl}</p>;
}
