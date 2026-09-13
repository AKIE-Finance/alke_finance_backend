import { IsIn, IsString, MinLength } from 'class-validator';

export const KYC_DOCUMENT_KINDS = ['FRONT', 'BACK', 'SELFIE'] as const;

export class AddKycDocumentDto {
  @IsIn(KYC_DOCUMENT_KINDS, { message: 'Le type de pièce doit être FRONT, BACK ou SELFIE.' })
  kind: (typeof KYC_DOCUMENT_KINDS)[number];

  @IsIn(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], { message: 'Format accepté : JPEG, PNG, WebP ou PDF.' })
  contentType: string;

  /** Base64 (with or without a data: prefix), decoded size ≤ 5 MB. */
  @IsString()
  @MinLength(1)
  base64: string;
}
