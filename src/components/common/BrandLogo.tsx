import React, { useState } from 'react';
import { BRAND_LOGO_URL, BRAND_NAME } from '../../constants/departments';

export const BrandLogo: React.FC<{ size?: 'sm' | 'md' | 'lg' }> = ({ size = 'md' }) => {
  const [imgError, setImgError] = useState(false);

  const dims =
    size === 'sm' ? 'h-9 w-9' : size === 'lg' ? 'h-24 w-24' : 'h-12 w-12';

  if (imgError) {
    return (
      <div
        className={`${dims} flex items-center justify-center rounded-xl bg-[#D91B23] text-white font-display font-bold shrink-0`}
        aria-label={BRAND_NAME}
      >
        م ي
      </div>
    );
  }

  return (
    <img
      src={BRAND_LOGO_URL}
      alt={BRAND_NAME}
      referrerPolicy="no-referrer"
      onError={() => setImgError(true)}
      className={`${dims} rounded-xl object-contain bg-white border border-zinc-200 p-0.5 shrink-0`}
    />
  );
};
