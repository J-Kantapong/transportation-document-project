import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AdminUsersModule } from './admin-users/admin-users.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BillingModule } from './billing/billing.module.js';
import { BookPhotosModule } from './book-photos/book-photos.module.js';
import { BrandsModule } from './brands/brands.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { DeliveryModule } from './delivery/delivery.module.js';
import { DocumentSubmissionModule } from './document-submission/document-submission.module.js';
import { FinanceCompaniesModule } from './finance-companies/finance-companies.module.js';
import { PortalModule } from './portal/portal.module.js';
import { PlatePhotosModule } from './plate-photos/plate-photos.module.js';
import { PlateSwapModule } from './plate-swap/plate-swap.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ReceiptsModule } from './receipts/receipts.module.js';
import { ReceivingModule } from './receiving/receiving.module.js';
import { TaxModule } from './tax/tax.module.js';
import { TaxRenewalModule } from './tax-renewal/tax-renewal.module.js';
import { VehicleOwnersModule } from './vehicle-owners/vehicle-owners.module.js';
import { VehiclesModule } from './vehicles/vehicles.module.js';
import { YamahaRelocationModule } from './yamaha-relocation/yamaha-relocation.module.js';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    AdminUsersModule,
    PortalModule,
    CustomersModule,
    BrandsModule,
    FinanceCompaniesModule,
    TaxModule,
    TaxRenewalModule,
    VehicleOwnersModule,
    VehiclesModule,
    YamahaRelocationModule,
    PlateSwapModule,
    DocumentSubmissionModule,
    ReceivingModule,
    ReceiptsModule,
    PlatePhotosModule,
    BookPhotosModule,
    DeliveryModule,
    BillingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
