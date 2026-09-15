import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const customers = sqliteTable('customers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  company: text('company').notNull(),
  branch: text('branch').notNull(),
  address: text('address').notNull(),
  taxId: text('tax_id').notNull(),
  phone: text('phone').notNull(),
  email: text('email').notNull(),
  createdAt: text('created_at').notNull(),
});
export const brands = sqliteTable('brands', {id:text('id').primaryKey(),name:text('name').notNull().unique()});
export const vehicles = sqliteTable('vehicles', {
 id:text('id').primaryKey(), date:text('date').notNull(), customerId:text('customer_id').notNull().references(()=>customers.id),
 chassis:text('chassis').notNull().unique(),engine:text('engine').notNull(),brandId:text('brand_id').notNull().references(()=>brands.id),
 fuel:text('fuel').notNull(),cc:text('cc').notNull(),weight:text('weight').notNull(),color:text('color').notNull(),body:text('body').notNull(),
 registrationProvince:text('registration_province').notNull(),ownerProvince:text('owner_province').notNull(),createdAt:text('created_at').notNull()
});
