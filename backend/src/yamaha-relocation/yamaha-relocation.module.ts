import { Module } from '@nestjs/common';
import { YamahaRelocationController } from './yamaha-relocation.controller.js';
import { YamahaRelocationService } from './yamaha-relocation.service.js';

@Module({
  controllers: [YamahaRelocationController],
  providers: [YamahaRelocationService],
})
export class YamahaRelocationModule {}
