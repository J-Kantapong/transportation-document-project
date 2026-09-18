import { Controller, Get, Query } from '@nestjs/common';
import { ExpensesService } from './expenses.service.js';

// สรุปค่าใช้จ่ายรายวัน - อ่านอย่างเดียว คำนวณจากค่าใช้จ่ายที่บันทึกไว้ในแต่ละขั้นตอน + DailyExpenseRule
// (contract และกติกาการนับ: docs/DAILY-EXPENSES.md)
@Controller('api/expenses')
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Get('daily')
  daily(@Query('date') date: string) {
    return this.expensesService.daily(date);
  }

  @Get('daily-totals')
  dailyTotals(@Query('from') from: string, @Query('to') to: string) {
    return this.expensesService.dailyTotals(from, to);
  }

  @Get('rules')
  listRules() {
    return this.expensesService.listRules();
  }
}
