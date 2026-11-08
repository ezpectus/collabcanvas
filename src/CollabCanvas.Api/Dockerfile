FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY src/CollabCanvas.Api/CollabCanvas.Api.csproj src/CollabCanvas.Api/
COPY src/CollabCanvas.Core/CollabCanvas.Core.csproj src/CollabCanvas.Core/
RUN dotnet restore src/CollabCanvas.Api/CollabCanvas.Api.csproj
COPY . .
RUN dotnet publish src/CollabCanvas.Api/CollabCanvas.Api.csproj -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app .
EXPOSE 8080
ENTRYPOINT ["dotnet", "CollabCanvas.Api.dll"]
