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
import { HrModule } from './hr/hr.module.js';
import { FinanceCompaniesModule } from './finance-companies/finance-companies.module.js';
import { OverviewModule } from './overview/overview.module.js';
import { VehicleSearchModule } from './vehicle-search/vehicle-search.module.js';
import { PortalModule } from './portal/portal.module.js';
import { PlatePhotosModule } from './plate-photos/plate-photos.module.js';
import { PlateSwapModule } from './plate-swap/plate-swap.module.js';
import { VehicleMoveOutModule } from './vehicle-move-out/vehicle-move-out.module.js';
import { VehicleUseCancellationModule } from './vehicle-use-cancellation/vehicle-use-cancellation.module.js';
import { VehicleTransferModule } from './vehicle-transfer/vehicle-transfer.module.js';
import { PlateCopyModule } from './plate-copy/plate-copy.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ReceiptsModule } from './receipts/receipts.module.js';
import { ReceivingModule } from './receiving/receiving.module.js';
import { SecretaryModule } from './secretary/secretary.module.js';
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
    VehicleUseCancellationModule,
    VehicleMoveOutModule,
    VehicleTransferModule,
    PlateCopyModule,
    DocumentSubmissionModule,
    ReceivingModule,
    ReceiptsModule,
    PlatePhotosModule,
    BookPhotosModule,
    DeliveryModule,
    BillingModule,
    OverviewModule,
    HrModule,
    VehicleSearchModule,
    SecretaryModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
