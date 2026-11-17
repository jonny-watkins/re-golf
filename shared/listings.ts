import { z } from 'zod';

export const categories = ['Drivers', 'Irons', 'Putters', 'Wedges', 'Woods', 'Bags & gear'] as const;
export const conditions = ['New', 'Very good', 'Good', 'Well played'] as const;
export const handednessOptions = ['Right', 'Left', 'Ambidextrous'] as const;
export const shaftFlexOptions = ['Ladies', 'Senior', 'Regular', 'Stiff', 'Extra stiff', 'Uniflex'] as const;
export const maxPhotos = 6;
export const maxPhotoBytes = 8 * 1024 * 1024;
export const listingInput = z.object({
  name: z.string().trim().min(1).max(70),
  brand: z.string().trim().min(1).max(40),
  category: z.enum(categories),
  condition: z.enum(conditions),
  price_pence: z.number().int().min(100).max(2_000_000),
  location: z.string().trim().min(1).max(40),
  description: z.string().trim().max(2000).default(''),
  handedness: z.enum(handednessOptions).nullable().default(null),
  shaft_flex: z.enum(shaftFlexOptions).nullable().default(null),
  loft: z.number().min(1).max(90).multipleOf(0.5).nullable().default(null),
}).strict();

export type ListingInput = z.infer<typeof listingInput>;
export type ListingPhoto = { id: string; position: number };
export type Listing = ListingInput & {
  id: string;
  seller_id: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
  listing_photos?: ListingPhoto[];
};

export const listingColumns = 'id,seller_id,name,brand,category,condition,price_pence,location,description,handedness,shaft_flex,loft,status,created_at,updated_at,listing_photos(id,position)';
