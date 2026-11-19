import GoogleIcon from '@mui/icons-material/Google';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import MicrosoftIcon from '@mui/icons-material/Microsoft';

/** The provider's mark, labelled for a screen reader. */
export function ProviderMark({ provider, fontSize }: { provider: string; fontSize?: 'small' | 'medium' }) {
  if (provider === 'google') return <GoogleIcon aria-label="Google" fontSize={fontSize} />;
  if (provider === 'microsoft') return <MicrosoftIcon aria-label="Microsoft" fontSize={fontSize} />;
  return <LinkOutlinedIcon aria-label="Other" fontSize={fontSize} />;
}
