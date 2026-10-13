import { Module } from '@nestjs/common';
import { MyWorkController } from './my-work.controller.js';
import { MyWorkService } from './my-work.service.js';

@Module({
  controllers: [MyWorkController],
  providers: [MyWorkService],
})
export class MyWorkModule {}
