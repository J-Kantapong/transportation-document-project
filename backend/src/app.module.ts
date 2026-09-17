import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { BrandsModule } from './brands/brands.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { VehiclesModule } from './vehicles/vehicles.module.js';
import { YamahaRelocationModule } from './yamaha-relocation/yamaha-relocation.module.js';

@Module({
  imports: [PrismaModule, CustomersModule, BrandsModule, VehiclesModule, YamahaRelocationModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
