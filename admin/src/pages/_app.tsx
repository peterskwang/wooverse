import type { AppProps } from 'next/app';
import 'leaflet/dist/leaflet.css';
import '../styles/globals.css';

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
