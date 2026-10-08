import { Controller, Get, Query } from '@nestjs/common';
import { VehicleSearchService } from './vehicle-search.service.js';

@Controller('api/vehicle-search')
export class VehicleSearchController {
  constructor(private readonly vehicleSearchService: VehicleSearchService) {}

  // งานอื่นๆ (ไม่ใช่รถจดใหม่) ที่ตรงกับคำค้น: ?q= (ต้องมี) &from=&to= &kind=car|moto
  @Get('jobs')
  jobs(@Query('q') q?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('kind') kind?: string) {
    return this.vehicleSearchService.searchOtherJobs({ q, from, to, kind });
  }

  // ?q=คำค้น &from=&to= (ค.ศ. YYYY-MM-DD) &status=ขั้น|done|problem &kind=car|moto &offset= (ทีละ 100 คัน)
  @Get()
  search(
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('offset') offset?: string,
  ) {
    return this.vehicleSearchService.search({ q, from, to, status, kind, offset });
  }
}
