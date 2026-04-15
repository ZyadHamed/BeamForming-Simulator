import { Pipe, PipeTransform } from '@angular/core';

interface HasConnection { connectedTowerId: string | null; }

@Pipe({ name: 'userCount', standalone: true, pure: false })
export class UserCountPipe implements PipeTransform {
  transform(users: HasConnection[], towerId: string): number {
    return users.filter(u => u.connectedTowerId === towerId).length;
  }
}
