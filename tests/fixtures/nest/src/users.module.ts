// @ts-nocheck
import { Module as FeatureModule } from "@nestjs/common";
import { AuthGuard } from "./auth.guard";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@FeatureModule({
  controllers: [UsersController],
  providers: [UsersService, AuthGuard],
  exports: [UsersService],
})
export class UsersModule {}
